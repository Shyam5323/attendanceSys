require("dotenv").config();
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { Canvas, createCanvas, loadImage, Image, ImageData } = require("canvas");
const faceapi = require("face-api.js");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const mongoSanitize = require("express-mongo-sanitize");
const path = require("path");
const fs = require("fs");
// require("@tensorflow/tfjs-node");

// AWS SDK imports
const AWS = require("aws-sdk");
const dynamodb = new AWS.DynamoDB.DocumentClient();
const s3 = new AWS.S3();
const sns = new AWS.SNS();
const ses = new AWS.SES({ apiVersion: "2010-12-01" });

// Configure AWS
AWS.config.update({
  region: process.env.AWS_REGION || "us-east-1",
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Set up environment for face-api.js with node-canvas
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

// Initialize Express with security middleware
const app = express();
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(mongoSanitize());
app.use(express.static(path.join(__dirname, "client")));

// ======================
// 1. Configuration
// ======================
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET;
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5500";

// DynamoDB Table Names
const USERS_TABLE = process.env.USERS_TABLE || "FaceAttendanceUsers";
const STUDENTS_TABLE = process.env.STUDENTS_TABLE || "FaceAttendanceStudents";
const ATTENDANCE_TABLE =
  process.env.ATTENDANCE_TABLE || "FaceAttendanceRecords";

// S3 Bucket Configuration
const S3_BUCKET = process.env.S3_BUCKET || "face-attendance-images";
const S3_BASE_URL = `https://${S3_BUCKET}.s3.amazonaws.com`;

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: "Too many requests from this IP",
});

// ======================
// 2. Database Models (DynamoDB)
// ======================

// User model functions
async function createUser(email, password) {
  const hashedPassword = await bcrypt.hash(password, 10);
  const params = {
    TableName: USERS_TABLE,
    Item: {
      email,
      password: hashedPassword,
      createdAt: new Date().toISOString(),
    },
  };
  await dynamodb.put(params).promise();
  return params.Item;
}

async function getUserByEmail(email) {
  const params = {
    TableName: USERS_TABLE,
    Key: { email },
  };
  const result = await dynamodb.get(params).promise();
  return result.Item;
}

// Student model functions
async function createStudent(studentData) {
  const params = {
    TableName: STUDENTS_TABLE,
    Item: studentData,
  };
  await dynamodb.put(params).promise();
  return params.Item;
}

async function getStudentByStudentId(studentId) {
  const params = {
    TableName: STUDENTS_TABLE,
    Key: { studentId },
  };
  const result = await dynamodb.get(params).promise();
  return result.Item;
}

async function getStudentByEmail(email) {
  const params = {
    TableName: STUDENTS_TABLE,
    IndexName: "EmailIndex",
    KeyConditionExpression: "email = :email",
    ExpressionAttributeValues: { ":email": email },
  };
  const result = await dynamodb.query(params).promise();
  return result.Items[0];
}

async function getAllStudents() {
  const params = {
    TableName: STUDENTS_TABLE,
  };
  const result = await dynamodb.scan(params).promise();
  return result.Items;
}

// Attendance model functions
async function createAttendanceRecord(record) {
  const params = {
    TableName: ATTENDANCE_TABLE,
    Item: record,
  };

  await dynamodb.put(params).promise();
  return params.Item;
}

async function getAttendanceForStudent(studentId, datetimeSlot) {
  const params = {
    TableName: ATTENDANCE_TABLE,
    IndexName: "StudentDateIndex",
    KeyConditionExpression:
      "studentId = :studentId AND #datetimeSlot = :datetimeSlot",
    ExpressionAttributeNames: { "#datetimeSlot": "datetimeSlot" },
    ExpressionAttributeValues: {
      ":studentId": studentId,
      ":datetimeSlot": datetimeSlot,
    },
  };
  const result = await dynamodb.query(params).promise();
  return result.Items[0];
}

async function getAttendanceReport(startDate, endDate, department) {
  let params = {
    TableName: ATTENDANCE_TABLE,
    IndexName: "DateIndex",
    KeyConditionExpression:
      "shardId = :shardId AND #date BETWEEN :startDate AND :endDate",
    ExpressionAttributeNames: { "#date": "date" },
    ExpressionAttributeValues: {
      ":shardId": "1",
      ":startDate": startDate,
      ":endDate": endDate,
    },
  };

  if (department && department !== "all") {
    params.FilterExpression = "department = :department";
    params.ExpressionAttributeValues[":department"] = department;
  }

  const result = await dynamodb.query(params).promise();

  // Need to join with student data
  const reportData = [];
  for (const record of result.Items) {
    const student = await getStudentByStudentId(record.studentId);
    if (student) {
      reportData.push({
        date: record.date,
        studentId: student.studentId,
        studentName: student.name,
        department: student.department,
        timeSlot: record.timeSlot,
      });
    }
  }

  return reportData;
}

// S3 Functions
async function uploadImageToS3(studentId, imageData) {
  const buffer = Buffer.from(
    imageData.replace(/^data:image\/\w+;base64,/, ""),
    "base64"
  );
  const key = `students/${studentId}-${Date.now()}.jpg`;

  const params = {
    Bucket: S3_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: "image/jpeg",
    ACL: "public-read",
  };

  await s3.upload(params).promise();
  return `${S3_BASE_URL}/${key}`;
}

// SNS Functions
async function sendAttendanceNotification(studentEmail, timeSlot) {
  if (!studentEmail) {
    console.error("No email provided for attendance notification");
    return;
  }

  const verifiedSenderEmail = "shyammm53@gmail.com";

  if (!studentEmail || !verifiedSenderEmail.includes("@")) {
    console.error(
      "Skipping email: Invalid studentEmail or unconfigured verifiedSenderEmail."
    );
    return;
  }

  try {
    const verifiedEmails = await ses.listVerifiedEmailAddresses().promise();

    if (!verifiedEmails.VerifiedEmailAddresses.includes(studentEmail)) {
      console.warn("Not registered email:", studentEmail);
    }
  } catch (err) {
    console.error("Error checking verified emails:", err);
  }

  const params = {
    Destination: {
      ToAddresses: [studentEmail],
    },
    Message: {
      Body: {
        Html: {
          Charset: "UTF-8",
          Data: `
            <html>
            <body>
              <h1>Attendance Marked</h1>
              <p>Dear Student,</p>
              <p>Your attendance has been successfully recorded for the ${
                timeSlot === "morning"
                  ? "Morning (9:00 AM)"
                  : "Afternoon (2:00 PM)"
              } session.</p>
              <p>Thank you for using our Face Recognition Attendance System.</p>
              <p>Best regards,<br>The Attendance Team</p>
            </body>
            </html>
          `,
        },
        Text: {
          Charset: "UTF-8",
          Data: `Your attendance has been successfully recorded for the ${
            timeSlot === "morning" ? "Morning (9:00 AM)" : "Afternoon (2:00 PM)"
          } session.\n\nThank you!`,
        },
      },
      Subject: {
        Charset: "UTF-8",
        Data: "Attendance Confirmation Notification",
      },
    },
    Source: verifiedSenderEmail,
  };

  try {
    const data = await ses.sendEmail(params).promise();
    console.log(
      `Email sent successfully to ${studentEmail}. Message ID: ${data.MessageId}`
    );
    return true;
  } catch (err) {
    console.error(`Error sending email to ${studentEmail}:`, err);
    return false;
  }
}

async function verifyAndAddSESEmail(email) {
  const params = {
    EmailAddress: email,
  };

  try {
    const verifiedEmails = await ses.listVerifiedEmailAddresses().promise();

    if (verifiedEmails.VerifiedEmailAddresses.includes(email)) {
      return true; // Already verified
    }

    // If not verified, send verification email
    await ses.verifyEmailIdentity(params).promise();
    console.log(`Verification email sent to ${email}`);
    return false; // Not yet verified
  } catch (err) {
    console.error(`Error verifying email ${email}:`, err);
    throw err;
  }
}
// ======================
// 3. Middleware
// ======================
const allowedOrigins = [
  "http://127.0.0.1:5500",
  "http://127.0.0.1:5000",
  "http://localhost:5500",
  "http://localhost:5000",
  "http://13.201.185.149",
  // Add other development URLs as needed
];
app.use(cors({ credentials: true }));
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      const msg = `Origin ${origin} not allowed by CORS policy`;
      return callback(new Error(msg), false);
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

// Handle preflight requests
app.options("*", cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Make the models directory accessible
app.use("/models", express.static(path.join(__dirname, "models")));
app.use(express.static(path.join(__dirname, "public")));

const authenticate = (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "No token provided" });

  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

// ======================
// 4. Face API Setup
// ======================
let modelPathsVerified = false;

async function verifyModelPaths() {
  const modelDir = path.join(__dirname, "models");

  if (!fs.existsSync(modelDir)) {
    console.error("❌ Models directory does not exist:", modelDir);
    console.log("Creating models directory...");
    fs.mkdirSync(modelDir, { recursive: true });
  }

  const requiredFiles = [
    "face_landmark_68_model-shard1",
    "face_landmark_68_model-weights_manifest.json",
    "face_recognition_model-shard1",
    "face_recognition_model-shard2",
    "face_recognition_model-weights_manifest.json",
    "tiny_face_detector_model-shard1",
    "tiny_face_detector_model-weights_manifest.json",
    "face_landmark_68_tiny_model-shard1",
  ];

  const missingFiles = [];
  for (const file of requiredFiles) {
    const filePath = path.join(modelDir, file);
    if (!fs.existsSync(filePath)) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length > 0) {
    console.error("❌ Missing model files:", missingFiles);
    console.error(
      "Please download the face-api.js models and place them in:",
      modelDir
    );
    return false;
  }

  return true;
}

async function loadFaceModels() {
  try {
    const pathsOK = await verifyModelPaths();
    if (!pathsOK) {
      throw new Error("Model paths verification failed");
    }

    modelPathsVerified = true;
    const modelDir = path.join(__dirname, "models");

    await faceapi.nets.tinyFaceDetector.loadFromDisk(modelDir);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelDir);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelDir);

    console.log("✅ Face models loaded successfully");
    return true;
  } catch (err) {
    console.error("❌ Face model loading failed:", err);
    return false;
  }
}

// ======================
// 5. Routes
// ======================
app.get("/api/health", (req, res) => {
  res.json({
    status: "OK",
    faceModels: modelPathsVerified ? "verified" : "not verified",
  });
});

// Auth Routes
app.post("/api/auth/login", apiLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const user = await getUserByEmail(email);

    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "1h" });
    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// Student Registration
app.post("/api/students", authenticate, apiLimiter, async (req, res) => {
  try {
    const { studentId, name, email, department, image } = req.body;

    if (!studentId || !name || !email || !department || !image) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Check if models are loaded
    if (!modelPathsVerified) {
      await loadFaceModels();
    }

    // Process image and detect face
    const img = await loadImage(image);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const detections = await faceapi
      .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length !== 1) {
      return res.status(400).json({ error: "Exactly one face required" });
    }

    const descriptor = Array.from(detections[0].descriptor);
    if (descriptor.length !== 128) {
      return res.status(400).json({ error: "Invalid face descriptor" });
    }

    // Check for existing face
    const students = await getAllStudents();
    if (students.length > 0) {
      const labeledDescriptors = students.map(
        (student) =>
          new faceapi.LabeledFaceDescriptors(student.studentId, [
            new Float32Array(student.faceDescriptor),
          ])
      );

      const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
      const bestMatch = faceMatcher.findBestMatch(detections[0].descriptor);

      if (bestMatch.label !== "unknown") {
        const existingStudent = await getStudentByStudentId(bestMatch.label);
        if (existingStudent) {
          return res.status(400).json({
            error: "This face is already registered",
            existingStudent: {
              studentId: existingStudent.studentId,
              name: existingStudent.name,
              email: existingStudent.email,
            },
          });
        }
      }
    }

    // Check for existing email or student ID
    const existingByStudentId = await getStudentByStudentId(studentId);
    if (existingByStudentId) {
      return res.status(400).json({ error: "Student ID already exists" });
    }

    const existingByEmail = await getStudentByEmail(email);
    if (existingByEmail) {
      return res.status(400).json({ error: "Email already exists" });
    }

    // Upload image to S3
    const imageUrl = await uploadImageToS3(studentId, image);

    const student = {
      studentId,
      name,
      email,
      department,
      faceDescriptor: descriptor,
      imageUrl,
      registeredAt: new Date().toISOString(),
    };

    await createStudent(student);
    try {
      const verifiedEmails = await ses.listVerifiedEmailAddresses().promise();

      if (!verifiedEmails.VerifiedEmailAddresses.includes(email)) {
        verifiedSenderEmail = await verifyAndAddSESEmail(emailx1);
      }
    } catch (err) {
      console.error("Error checking verified emails:", err);
    }
    res.json({
      studentId: student.studentId,
      name: student.name,
      email: student.email,
      department: student.department,
    });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Registration failed: " + err.message });
  }
});

// Get all students
app.get("/api/students", authenticate, async (req, res) => {
  try {
    const students = await getAllStudents();
    res.json(
      students.map((s) => ({
        studentId: s.studentId,
        name: s.name,
        email: s.email,
        department: s.department,
      }))
    );
  } catch (err) {
    console.error("Get students error:", err);
    res.status(500).json({ error: "Failed to fetch students" });
  }
});

// Attendance Routes
app.post("/api/attendance", authenticate, apiLimiter, async (req, res) => {
  try {
    const { image, timeSlot } = req.body;

    if (!image || !timeSlot) {
      return res.status(400).json({ error: "Image and timeSlot are required" });
    }

    // Check if models are loaded
    if (!modelPathsVerified) {
      await loadFaceModels();
    }

    const img = await loadImage(image);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const detections = await faceapi
      .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks()
      .withFaceDescriptors();

    if (detections.length !== 1) {
      return res.status(400).json({ error: "Exactly one face required" });
    }

    // Find matching student
    const students = await getAllStudents();
    const labeledDescriptors = students.map(
      (student) =>
        new faceapi.LabeledFaceDescriptors(student.studentId, [
          new Float32Array(student.faceDescriptor),
        ])
    );

    const faceMatcher = new faceapi.FaceMatcher(labeledDescriptors, 0.6);
    const bestMatch = faceMatcher.findBestMatch(detections[0].descriptor);

    if (bestMatch.label === "unknown") {
      return res.status(404).json({ error: "No matching student found" });
    }

    const student = await getStudentByStudentId(bestMatch.label);
    if (!student) {
      return res.status(404).json({ error: "Student not found" });
    }

    const today = new Date().toISOString().split("T")[0];
    const datetimeSlot = `${today}#${timeSlot}`;
    const existingAttendance = await getAttendanceForStudent(
      student.studentId,
      datetimeSlot
    );

    if (existingAttendance) {
      return res.status(400).json({
        error: "Attendance already marked for this time slot today",
        student: {
          name: student.name,
          studentId: student.studentId,
        },
      });
    }
    const attendance = {
      studentId: student.studentId,
      date: today,
      timeSlot: timeSlot,
      datetimeSlot,
      method: "face",
      timestamp: new Date().toISOString(),
      department: student.department,
      shardId: "1",
    };
    await createAttendanceRecord(attendance);

    // Send notification
    try {
      await sendAttendanceNotification(student.email, timeSlot);
    } catch (err) {
      console.error("Failed to send notification:", err);
    }

    res.json({
      success: true,
      student: {
        name: student.name,
        studentId: student.studentId,
      },
      timestamp: attendance.timestamp,
    });
  } catch (err) {
    console.error("Attendance error:", err);
    res.status(500).json({ error: "Attendance marking failed" });
  }
});

// Report Routes
app.get("/api/attendance/report", authenticate, async (req, res) => {
  try {
    const { startDate, endDate, department } = req.query;

    // Default to last 7 days if no date range provided
    const defaultStartDate = new Date();
    defaultStartDate.setDate(defaultStartDate.getDate() - 7);

    const reportData = await getAttendanceReport(
      startDate || defaultStartDate.toISOString().split("T")[0],
      endDate || new Date().toISOString().split("T")[0],
      department
    );

    res.json(reportData);
  } catch (err) {
    console.error("Report error:", err);
    res.status(500).json({ error: "Failed to generate report" });
  }
});

// Default route
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "client", "index.html"));
});

// Handle 404s
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handling
app.use((err, req, res, next) => {
  console.error("Server error:", err);
  res.status(500).json({
    error: "Server error",
    message:
      process.env.NODE_ENV === "production"
        ? "Something went wrong"
        : err.message,
  });
});

// ======================
// 6. Server Initialization
// ======================
async function startServer() {
  await loadFaceModels();

  // Create default admin if not exists
  try {
    if (!(await getUserByEmail("admin@example.com"))) {
      await createUser("admin@example.com", "admin123");
      console.log("✅ Default admin created (admin@example.com / admin123)");
    }
  } catch (err) {
    console.error("❌ Error creating default admin:", err);
  }

  app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🔗 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🌐 Frontend URL: ${FRONTEND_URL}`);
  });
}

startServer();

module.exports = app;
