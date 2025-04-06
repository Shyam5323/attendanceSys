// Configuration
const API_BASE_URL = "/api"; // Use a relative path
let activeStream = null;
let isFaceApiReady = false;
let faceModelsLoaded = false;
let attendanceDetectionInterval = null;
let faceDetectionCount = 0;
const REQUIRED_DETECTION_FRAMES = 15; // About 3 seconds at 5fps

// ======================
// Core Functions
// ======================

// Initialize FaceAPI
async function loadFaceModels() {
  try {
    // Use the correct path to your models
    const modelPath = "/models";

    console.log("Loading models from:", modelPath);

    // Load models with error handling
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(modelPath).catch((e) => {
        console.error("Failed to load tinyFaceDetector:", e);
        throw e;
      }),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(modelPath).catch((e) => {
        console.error("Failed to load faceLandmark68TinyNet:", e);
        throw e;
      }),
      faceapi.nets.faceRecognitionNet.loadFromUri(modelPath).catch((e) => {
        console.error("Failed to load faceRecognitionNet:", e);
        throw e;
      }),
    ]);

    console.log("All models loaded successfully!");
    isFaceApiReady = true;

    // Verify models are loaded
    console.log("Model status:", {
      tinyFaceDetector: faceapi.nets.tinyFaceDetector.isLoaded,
      faceLandmark68Tiny: faceapi.nets.faceLandmark68TinyNet.isLoaded,
      faceRecognition: faceapi.nets.faceRecognitionNet.isLoaded,
    });
  } catch (error) {
    console.error("Face model loading error:", error);
    showError(
      "modelError",
      `
      Failed to load face detection models!<br>
      Please:<br>
      1. Check console for details<br>
      2. Verify models exist in /models folder<br>
      3. Refresh the page
    `
    );
    throw error;
  }
}

// Make sure to call this function when your app initializes
document.addEventListener("DOMContentLoaded", loadFaceModels);

// Camera Management
async function initCamera(videoElementId) {
  try {
    stopCamera();

    // First make sure models are loaded
    if (!isFaceApiReady) {
      await loadFaceModels();
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: "user",
      },
      audio: false,
    });

    const videoElement = document.getElementById(videoElementId);
    videoElement.srcObject = stream;

    return new Promise((resolve) => {
      videoElement.onloadedmetadata = () => {
        videoElement.play();
        activeStream = stream;

        const canvasId = videoElementId.replace("Video", "Canvas");
        document.getElementById(canvasId).style.display = "none";
        videoElement.style.display = "block";
        resolve(true);
      };
    });
  } catch (err) {
    console.error("Camera error:", err);
    showError(
      "registerResult",
      err.name === "NotAllowedError"
        ? "Please allow camera access in browser settings"
        : "Camera error: " + (err.message || "Check if camera is connected")
    );
    return false;
  }
}

function stopCamera() {
  if (activeStream) {
    activeStream.getTracks().forEach((track) => track.stop());
    activeStream = null;
  }
}

// ======================
// Feature Implementations
// ======================

document
  .getElementById("registerForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("registerBtn");
    const spinner = document.getElementById("registerSpinner");
    const text = document.getElementById("registerText");

    btn.disabled = true;
    text.style.display = "none";
    spinner.style.display = "inline-block";

    try {
      const canvas = document.getElementById("registerCanvas");
      if (canvas.style.display === "none") {
        throw new Error("Please capture photo first");
      }

      // Make sure models are loaded
      if (!isFaceApiReady) {
        await loadFaceModels();
      }

      // Convert canvas to image and detect faces
      const imgDataUrl = canvas.toDataURL("image/jpeg", 0.9);
      const img = await faceapi.fetchImage(imgDataUrl);

      const detections = await faceapi
        .detectAllFaces(
          img,
          new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.5 })
        )
        .withFaceLandmarks(true)
        .withFaceDescriptors();

      if (detections.length === 0) {
        throw new Error(
          "No face detected. Please try again with clearer lighting."
        );
      }

      if (detections.length > 1) {
        throw new Error(
          "Multiple faces detected. Please ensure only one face is in frame."
        );
      }

      const formData = {
        studentId: document.getElementById("studentId").value.trim(),
        name: document.getElementById("name").value.trim(),
        email: document.getElementById("regEmail").value.trim(),
        department: document.getElementById("department").value,
        image: imgDataUrl,
      };

      // Send to server (will be stored in S3 and DynamoDB)
      const response = await axios
        .post(`${API_BASE_URL}/students`, formData, {
          headers: getAuthHeaders(),
        })
        .catch((err) => {
          if (err.response?.data?.error === "This face is already registered") {
            const existing = err.response.data.existingStudent;
            throw new Error(`
          This face is already registered with:<br>
          ID: ${existing.studentId}<br>
          Name: ${existing.name}<br>
          Email: ${existing.email}
        `);
          }
          throw err;
        });

      showSuccess(
        "registerResult",
        `
      Registered successfully!<br>
      ID: ${response.data.studentId}<br>
      Name: ${response.data.name}<br>
      Image stored in S3
    `
      );

      document.getElementById("registerForm").reset();
      canvas.style.display = "none";
      document.getElementById("registerVideo").style.display = "block";
    } catch (err) {
      handleApiError("registerResult", err);
    } finally {
      btn.disabled = false;
      text.style.display = "inline";
      spinner.style.display = "none";
    }
  });

// Auto attendance detection
async function startAttendanceDetection() {
  if (attendanceDetectionInterval) return;

  const video = document.getElementById("attendanceVideo");
  const canvas = document.getElementById("attendanceCanvas");
  const resultEl = document.getElementById("attendanceResult");

  // Clear any previous messages
  resultEl.innerHTML = "";

  attendanceDetectionInterval = setInterval(async () => {
    try {
      if (!isFaceApiReady) return;

      // Set canvas dimensions to match video
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const detections = await faceapi
        .detectAllFaces(
          canvas,
          new faceapi.TinyFaceDetectorOptions({ scoreThreshold: 0.5 })
        )
        .withFaceLandmarks(true)
        .withFaceDescriptors();

      if (detections.length === 1) {
        faceDetectionCount++;

        // Show countdown to user
        resultEl.innerHTML = `<div class="info">Detected face (${faceDetectionCount}/${REQUIRED_DETECTION_FRAMES})</div>`;

        if (faceDetectionCount >= REQUIRED_DETECTION_FRAMES) {
          clearInterval(attendanceDetectionInterval);
          attendanceDetectionInterval = null;

          // Capture final image for submission
          const imgDataUrl = canvas.toDataURL("image/jpeg", 0.9);

          // Show processing message
          resultEl.innerHTML = `<div class="info">Processing attendance...</div>`;

          try {
            const response = await axios.post(
              `${API_BASE_URL}/attendance`,
              {
                image: imgDataUrl,
                timeSlot: document.getElementById("timeSlot").value,
              },
              {
                headers: getAuthHeaders(),
              }
            );

            showSuccess(
              "attendanceResult",
              `
              Attendance marked!<br>
              Name: ${response.data.student.name}<br>
              ID: ${response.data.student.studentId}<br>
              Time: ${new Date(
                response.data.timestamp
              ).toLocaleTimeString()}<br>
              Notification sent to ${response.data.student.email}
            `
            );
          } catch (err) {
            handleApiError("attendanceResult", err);
          }

          // Reset counter
          faceDetectionCount = 0;

          // Restart detection after a short delay
          setTimeout(startAttendanceDetection, 3000);
        }
      } else {
        // Reset counter if no face or multiple faces
        if (faceDetectionCount > 0) {
          faceDetectionCount = 0;
          resultEl.innerHTML = `<div class="info">Show your face clearly</div>`;
        }
      }
    } catch (err) {
      console.error("Face detection error:", err);
      if (attendanceDetectionInterval) {
        clearInterval(attendanceDetectionInterval);
        attendanceDetectionInterval = null;
      }
      faceDetectionCount = 0;
    }
  }, 200); // Run detection every 200ms (5fps)
}

function stopAttendanceDetection() {
  if (attendanceDetectionInterval) {
    clearInterval(attendanceDetectionInterval);
    attendanceDetectionInterval = null;
  }
  faceDetectionCount = 0;
}

// Generate Reports from DynamoDB
document.getElementById("reportForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const btn = document.getElementById("generateReportBtn");
  const spinner = document.getElementById("generateReportSpinner");
  const text = document.getElementById("generateReportText");

  btn.disabled = true;
  text.style.display = "none";
  spinner.style.display = "inline-block";

  try {
    // Prepare query parameters
    const params = new URLSearchParams({
      startDate: document.getElementById("startDate").value,
      endDate: document.getElementById("endDate").value,
      department: document.getElementById("reportDept").value,
    });

    // Fetch report data from DynamoDB
    const response = await axios.get(
      `${API_BASE_URL}/attendance/report?${params}`,
      {
        headers: getAuthHeaders(),
      }
    );

    // Display results
    displayReportData(response.data);
  } catch (err) {
    handleApiError("reportResult", err);
  } finally {
    btn.disabled = false;
    text.style.display = "inline";
    spinner.style.display = "none";
  }
});

// ======================
// Helper Functions
// ======================

// Get authentication headers
function getAuthHeaders() {
  const token = localStorage.getItem("token");
  if (!token) {
    window.location.href = "./index.html";
    throw new Error("Not authenticated");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// Display report data from DynamoDB
function displayReportData(data) {
  const container = document.getElementById("reportResult");

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="info">No attendance records found</div>';
    document.getElementById("exportBtn").style.display = "none";
    return;
  }

  // Generate HTML table
  let html = `
    <div class="table-container">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Student ID</th>
            <th>Name</th>
            <th>Department</th>
            <th>Time</th>
          </tr>
        </thead>
        <tbody>
  `;

  data.forEach((record) => {
    html += `
      <tr>
        <td>${new Date(record.date).toLocaleDateString()}</td>
        <td>${record.studentId}</td>
        <td>${record.studentName}</td>
        <td>${record.department}</td>
        <td>${record.timeSlot === "morning" ? "9:00 AM" : "2:00 PM"}</td>
      </tr>
    `;
  });

  html += `
        </tbody>
      </table>
    </div>
  `;

  container.innerHTML = html;
  document.getElementById("exportBtn").style.display = "block";
  window.reportData = data; // Store for export
}

// Export to CSV
document.getElementById("exportBtn")?.addEventListener("click", () => {
  if (!window.reportData || window.reportData.length === 0) return;

  let csvContent = "Date,Student ID,Name,Department,Time\n";

  window.reportData.forEach((record) => {
    csvContent +=
      `"${new Date(record.date).toLocaleDateString()}",` +
      `"${record.studentId}","${record.studentName}",` +
      `"${record.department}","${
        record.timeSlot === "morning" ? "9:00 AM" : "2:00 PM"
      }"\n`;
  });

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute(
    "download",
    `attendance_report_${new Date().toISOString().slice(0, 10)}.csv`
  );
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
});

// Show error message
function showError(elementId, message) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element #${elementId} not found`);
    return;
  }
  element.innerHTML = `<div class="error">${message}</div>`;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Show success message
function showSuccess(elementId, message) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element #${elementId} not found`);
    return;
  }
  element.innerHTML = `<div class="success">${message}</div>`;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

function handleApiError(elementId, err) {
  console.error("API Error:", err);

  if (err.response?.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "./index.html";
    return;
  }
  showError(elementId, err.response?.data?.error || err.message);
}

// Capture photo from video
document.getElementById("captureBtn")?.addEventListener("click", () => {
  const video = document.getElementById("registerVideo");
  const canvas = document.getElementById("registerCanvas");

  if (!video || !canvas) {
    showError("registerResult", "Camera elements not found");
    return false;
  }

  if (video.readyState !== 4) {
    showError("registerResult", "Camera not ready. Try again.");
    return false;
  }

  const ctx = canvas.getContext("2d");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  video.style.display = "none";
  canvas.style.display = "block";
  return true;
});

// ======================
// Initialization
// ======================

document.addEventListener("DOMContentLoaded", async () => {
  // Check authentication
  const token = localStorage.getItem("token");
  if (token) {
    document.getElementById("loginForm").style.display = "none";
    document.getElementById("appContent").style.display = "block";
    document.getElementById("userEmail").textContent =
      JSON.parse(atob(token.split(".")[1]))?.email || "Admin";
  } else if (!window.location.pathname.endsWith("index.html")) {
    window.location.href = "./index.html";
    return;
  }

  // Initialize face models - do this early
  try {
    await loadFaceModels();
  } catch (err) {
    console.error("Failed to load face models:", err);
    showError(
      "loginError",
      "Failed to initialize face recognition. Please check console for details."
    );
  }

  // Initialize first tab camera
  if (document.querySelector(".tab-btn.active")) {
    const activeTab = document
      .querySelector(".tab-btn.active")
      .getAttribute("data-tab");
    await initCamera(`${activeTab}Video`);
  }

  // Tab switching
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const tabName = btn.getAttribute("data-tab");

      // Hide all tabs
      document.querySelectorAll(".tab-content").forEach((tab) => {
        tab.classList.remove("active");
      });

      // Deactivate all buttons
      document.querySelectorAll(".tab-btn").forEach((tabBtn) => {
        tabBtn.classList.remove("active");
      });

      // Activate current tab
      document.getElementById(tabName).classList.add("active");
      btn.classList.add("active");

      // Initialize camera if needed
      if (tabName === "register" || tabName === "attendance") {
        await initCamera(`${tabName}Video`);
        if (tabName === "attendance") {
          startAttendanceDetection();
        } else {
          stopAttendanceDetection();
        }
      } else {
        stopCamera();
        stopAttendanceDetection();
      }
    });
  });

  // Login form
  document
    .getElementById("loginForm")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("loginBtn");
      const errorEl = document.getElementById("loginError");

      btn.disabled = true;
      errorEl.textContent = "";

      try {
        const response = await axios.post(`${API_BASE_URL}/auth/login`, {
          email: document.getElementById("loginEmail").value,
          password: document.getElementById("loginPassword").value,
        });

        localStorage.setItem("token", response.data.token);
        document.getElementById("loginForm").style.display = "none";
        document.getElementById("appContent").style.display = "block";
        document.getElementById("userEmail").textContent =
          document.getElementById("loginEmail").value;

        // Initialize first tab camera
        const activeTab = document
          .querySelector(".tab-btn.active")
          .getAttribute("data-tab");
        await initCamera(`${activeTab}Video`);
      } catch (err) {
        errorEl.textContent =
          err.response?.data?.error || "Login failed. Check credentials.";
      } finally {
        btn.disabled = false;
      }
    });

  // Logout
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    localStorage.removeItem("token");
    stopCamera();
    window.location.reload();
  });
});
