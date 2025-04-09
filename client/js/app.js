// Configuration
const API_BASE_URL = "/api";
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
    const modelPath = "/models"; // or '/client/models' if needed

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
      2. Verify models exist in /client/models folder<br>
      3. Refresh the page
    `
    );
    throw error;
  }
}

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

// Student Registration
document
  .getElementById("registerForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("registerBtn");
    const spinner = document.getElementById("registerSpinner");
    const text = document.getElementById("registerText");

    btn.disabled = true;
    text.style.display = "none";
    spinner.classList.add("active");

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

      // Send to server
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
      Name: ${response.data.name}
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
      spinner.classList.remove("active");
    }
  });

// Attendance Marking
async function startAttendanceDetection() {
  if (attendanceDetectionInterval) return;

  const video = document.getElementById("attendanceVideo");
  const canvas = document.getElementById("attendanceCanvas");
  const resultEl = document.getElementById("attendanceResult");
  const statusEl = document.querySelector(".recognition-status span");

  // Clear any previous messages
  resultEl.innerHTML = "";

  // Fetch current admin's student count for display
  try {
    const students = await getAdminStudents();
    document.getElementById("totalStudents").textContent = students.length || 0;
  } catch (err) {
    console.error("Error fetching students:", err);
  }

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

        // Update status
        statusEl.textContent = `Detected face (${faceDetectionCount}/${REQUIRED_DETECTION_FRAMES})`;

        if (faceDetectionCount >= REQUIRED_DETECTION_FRAMES) {
          clearInterval(attendanceDetectionInterval);
          attendanceDetectionInterval = null;

          // Capture final image for submission
          const imgDataUrl = canvas.toDataURL("image/jpeg", 0.9);

          // Show processing message
          statusEl.textContent = "Processing attendance...";

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

            // Update attendance stats
            updateAttendanceStats(response.data.stats);

            showSuccess(
              "attendanceResult",
              `
              Attendance marked!<br>
              Name: ${response.data.student.name}<br>
              ID: ${response.data.student.studentId}<br>
              Time: ${new Date(response.data.timestamp).toLocaleTimeString()}
            `
            );
          } catch (err) {
            handleApiError("attendanceResult", err);
          }

          // Reset counter
          faceDetectionCount = 0;
          statusEl.textContent = "Ready for recognition";

          // Restart detection after a short delay
          setTimeout(startAttendanceDetection, 3000);
        }
      } else {
        // Reset counter if no face or multiple faces
        if (faceDetectionCount > 0) {
          faceDetectionCount = 0;
          statusEl.textContent = "Show your face clearly";
        }
      }
    } catch (err) {
      console.error("Face detection error:", err);
      if (attendanceDetectionInterval) {
        clearInterval(attendanceDetectionInterval);
        attendanceDetectionInterval = null;
      }
      faceDetectionCount = 0;
      statusEl.textContent = "Ready for recognition";
    }
  }, 200); // Run detection every 200ms (5fps)
}

function updateAttendanceStats(stats) {
  if (stats) {
    document.getElementById("totalStudents").textContent =
      stats.totalStudents || 0;
    document.getElementById("presentStudents").textContent =
      stats.presentToday || 0;
    document.getElementById("attendancePercentage").textContent =
      stats.attendanceRate ? `${stats.attendanceRate}%` : "0%";
  }
}

function stopAttendanceDetection() {
  if (attendanceDetectionInterval) {
    clearInterval(attendanceDetectionInterval);
    attendanceDetectionInterval = null;
  }
  faceDetectionCount = 0;
  document.querySelector(".recognition-status span").textContent =
    "Ready for recognition";
}

// Generate Reports
document.getElementById("reportForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();

  const btn = document.getElementById("generateReportBtn");
  const spinner = document.getElementById("generateReportSpinner");
  const text = document.getElementById("generateReportText");

  btn.disabled = true;
  text.style.display = "none";
  spinner.classList.add("active");

  try {
    // Prepare query parameters
    const params = new URLSearchParams({
      startDate: document.getElementById("startDate").value,
      endDate: document.getElementById("endDate").value,
      department: document.getElementById("reportDept").value,
    });

    // Fetch report data
    const response = await axios.get(
      `${API_BASE_URL}/attendance/report?${params}`,
      {
        headers: getAuthHeaders(),
      }
    );
    console.log(response.data);

    // Display results
    displayReportData(response.data);
  } catch (err) {
    handleApiError("reportResult", err);
  } finally {
    btn.disabled = false;
    text.style.display = "inline";
    spinner.classList.remove("active");
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

// Display report data
function displayReportData(response) {
  // Get DOM elements with null checks
  const container = document.getElementById("reportResult");
  const tableBody = document.querySelector("#reportTable tbody");
  const exportBtn = document.getElementById("exportBtn");
  const chartContainer = document.getElementById("chartContainer");

  // Validate required elements exist
  if (!container || !tableBody) {
    console.error("Required report elements not found");
    return;
  }

  // Clear previous content
  container.innerHTML = "";
  tableBody.innerHTML = "";

  // Check if we have data
  if (!response || (!response.records && !Array.isArray(response))) {
    container.innerHTML = '<div class="info-message">No data available</div>';
    if (exportBtn) exportBtn.style.display = "none";
    return;
  }

  // Handle both old array format and new structured format
  const records = response.records || response;

  if (records.length === 0) {
    container.innerHTML =
      '<div class="info-message">No attendance records found</div>';
    if (exportBtn) exportBtn.style.display = "none";
    return;
  }

  // Add records to table
  records.forEach((record) => {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td>${record.studentId || ""}</td>
      <td>${record.studentName || record.name || ""}</td>
      <td>${record.department || ""}</td>
      <td>${record.date ? new Date(record.date).toLocaleDateString() : ""}</td>
      <td><span class="badge badge-success">Present</span></td>
      <td>${
        record.timeSlot
          ? record.timeSlot === "morning"
            ? "Morning"
            : record.timeSlot === "afternoon"
            ? "Afternoon"
            : "Evening"
          : ""
      }</td>
    `;
    tableBody.appendChild(row);
  });

  // Update summary stats if available
  if (response.summary) {
    const summaryElements = {
      totalRecords: document.getElementById("totalRecords"),
      avgAttendance: document.getElementById("avgAttendance"),
      topDepartment: document.getElementById("topDepartment"),
      mostPresent: document.getElementById("mostPresent")
    };

    // Only update elements that exist
    if (summaryElements.totalRecords) {
      summaryElements.totalRecords.textContent = 
        response.summary.totalRecords || records.length;
    }
    if (summaryElements.avgAttendance) {
      summaryElements.avgAttendance.textContent = response.summary.avgAttendance
        ? `${response.summary.avgAttendance}%`
        : "N/A";
    }
    if (summaryElements.topDepartment) {
      summaryElements.topDepartment.textContent = 
        response.summary.topDepartment || "-";
    }
    if (summaryElements.mostPresent) {
      summaryElements.mostPresent.textContent = 
        response.summary.mostPresentStudent || "-";
    }
  }

  // Initialize chart if data and container available
  if (response.chartData && response.chartData.length > 0 && chartContainer) {
    initAttendanceChart(response.chartData);
  } else if (chartContainer) {
    // Hide chart if no data but container exists
    chartContainer.style.display = "none";
  }

  // Show export button if it exists
  if (exportBtn) {
    exportBtn.style.display = "block";
  }
  
  // Store report data for export
  window.reportData = { records };
}

// Initialize attendance chart
function initAttendanceChart(chartData) {
  const ctx = document.getElementById("attendanceChart").getContext("2d");

  if (
    window.attendanceChart &&
    typeof window.attendanceChart.destroy === "function"
  ) {
    window.attendanceChart.destroy();
  }

  const labels = chartData.map((item) => item.date);
  const presentData = chartData.map((item) => item.present);
  const absentData = chartData.map((item) => item.absent);

  window.attendanceChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Present",
          data: presentData,
          backgroundColor: "rgba(67, 97, 238, 0.7)",
          borderColor: "rgba(67, 97, 238, 1)",
          borderWidth: 1,
        },
        {
          label: "Absent",
          data: absentData,
          backgroundColor: "rgba(247, 37, 133, 0.7)",
          borderColor: "rgba(247, 37, 133, 1)",
          borderWidth: 1,
        },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: "Number of Students",
          },
        },
        x: {
          title: {
            display: true,
            text: "Date",
          },
        },
      },
    },
  });
}

// Export to CSV
document.getElementById("exportBtn")?.addEventListener("click", () => {
  if (!window.reportData?.records || window.reportData.records.length === 0)
    return;

  let csvContent = "Date,Student ID,Name,Department,Status,Session\n";

  window.reportData.records.forEach((record) => {
    csvContent +=
      `"${new Date(record.date).toLocaleDateString()}",` +
      `"${record.studentId}","${record.studentName}",` +
      `"${record.department}","Present",` +
      `"${
        record.timeSlot === "morning"
          ? "Morning"
          : record.timeSlot === "afternoon"
          ? "Afternoon"
          : "Evening"
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

// Print Report
document.getElementById("printBtn")?.addEventListener("click", () => {
  window.print();
});

// Show error message
function showError(elementId, message) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element #${elementId} not found`);
    return;
  }
  element.innerHTML = `<div class="error-message">${message}</div>`;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

// Show success message
function showSuccess(elementId, message) {
  const element = document.getElementById(elementId);
  if (!element) {
    console.error(`Element #${elementId} not found`);
    return;
  }
  element.innerHTML = `<div class="success-message">${message}</div>`;
  element.scrollIntoView({ behavior: "smooth", block: "center" });
}

function handleApiError(elementId, err) {
  console.error("API Error:", err);

  if (err.response?.status === 401) {
    localStorage.removeItem("token");
    window.location.href = "./index.html";
    return;
  }

  const errorMessage = err.response?.data?.error || err.message;
  showError(elementId, errorMessage);
}

// Add a function to retrieve the active admin's students
async function getAdminStudents() {
  try {
    const response = await axios.get(`${API_BASE_URL}/students`, {
      headers: getAuthHeaders(),
    });
    return response.data;
  } catch (err) {
    console.error("Failed to fetch students:", err);
    return [];
  }
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

// Toggle password visibility
document.querySelectorAll(".password-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const input = toggle.parentElement.querySelector("input");
    const icon = toggle.querySelector("i");

    if (input.type === "password") {
      input.type = "text";
      icon.classList.replace("fa-eye", "fa-eye-slash");
    } else {
      input.type = "password";
      icon.classList.replace("fa-eye-slash", "fa-eye");
    }
  });
});

// ======================
// Initialization
// ======================

document.addEventListener("DOMContentLoaded", async () => {
  // Check authentication
  const token = localStorage.getItem("token");
  if (token) {
    document.getElementById("loginContainer").style.display = "none";
    document.getElementById("appContent").style.display = "flex";
    updateAdminInfoDisplay();
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

  // Tab switching
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.addEventListener("click", async () => {
      const tabName = item.getAttribute("data-tab");

      // Hide all tabs and deactivate all nav items
      document.querySelectorAll(".tab-content").forEach((tab) => {
        tab.classList.remove("active");
      });
      document.querySelectorAll(".nav-item").forEach((navItem) => {
        navItem.classList.remove("active");
      });

      // Activate current tab and nav item
      document.getElementById(tabName).classList.add("active");
      item.classList.add("active");
      document.getElementById("contentTitle").textContent =
        item.querySelector("span").textContent;

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
      const spinner = document.getElementById("loginSpinner");
      const text = document.getElementById("loginText");
      const errorEl = document.getElementById("loginError");

      btn.disabled = true;
      text.style.display = "none";
      spinner.classList.add("active");
      errorEl.textContent = "";

      try {
        const response = await axios.post(`${API_BASE_URL}/auth/login`, {
          email: document.getElementById("loginEmail").value,
          password: document.getElementById("loginPassword").value,
        });

        localStorage.setItem("token", response.data.token);

        // Store admin information
        if (response.data.user) {
          localStorage.setItem("adminInfo", JSON.stringify(response.data.user));
        }

        document.getElementById("loginContainer").style.display = "none";
        document.getElementById("appContent").style.display = "flex";

        // Update display with admin info
        const adminInfo = response.data.user || {
          email: document.getElementById("loginEmail").value,
        };
        document.getElementById("userEmail").textContent = adminInfo.email;
        if (adminInfo.name) {
          document.querySelector(".user-role").textContent =
            adminInfo.department || "Faculty";
        }

        // Initialize first tab camera
        const activeTab = document
          .querySelector(".nav-item.active")
          .getAttribute("data-tab");
        await initCamera(`${activeTab}Video`);

        if (activeTab === "attendance") {
          startAttendanceDetection();
        }
      } catch (err) {
        errorEl.textContent =
          err.response?.data?.error || "Login failed. Check credentials.";
      } finally {
        btn.disabled = false;
        text.style.display = "inline";
        spinner.classList.remove("active");
      }
    });

  // Add a function to update admin info display
  function updateAdminInfoDisplay() {
    const adminInfoStr = localStorage.getItem("adminInfo");
    if (adminInfoStr) {
      try {
        const adminInfo = JSON.parse(adminInfoStr);
        document.getElementById("userEmail").textContent =
          adminInfo.email || "Admin";
        document.querySelector(".user-role").textContent =
          adminInfo.department || "Faculty";

        // Update title
        if (adminInfo.name) {
          document.querySelector(
            ".sidebar-header h2"
          ).textContent = `${adminInfo.name}'s Class`;
        }
      } catch (e) {
        console.error("Error parsing admin info:", e);
      }
    }
  }

  // Logout
  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    localStorage.removeItem("token");
    stopCamera();
    stopAttendanceDetection();
    window.location.href = "./index.html";
  });

  // Set default dates for report
  const today = new Date();
  const oneWeekAgo = new Date();
  oneWeekAgo.setDate(today.getDate() - 7);

  document.getElementById("startDate").valueAsDate = oneWeekAgo;
  document.getElementById("endDate").valueAsDate = today;

  // Initialize first tab if authenticated
  if (token) {
    const firstTab = document.querySelector(".nav-item");
    if (firstTab) {
      firstTab.click();
    }
  }
});

// Admin registration form toggle
document
  .getElementById("showRegisterFormBtn")
  ?.addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("loginForm").style.display = "none";
    document.getElementById("adminRegisterForm").style.display = "block";
  });

document.getElementById("showLoginFormBtn")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("adminRegisterForm").style.display = "none";
  document.getElementById("loginForm").style.display = "block";
});

// Admin registration handler
document
  .getElementById("adminRegisterForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = document.getElementById("registerAdminBtn");
    const spinner = document.getElementById("registerAdminSpinner");
    const text = document.getElementById("registerAdminText");
    const errorEl = document.getElementById("registerAdminError");

    // Clear previous errors
    errorEl.textContent = "";

    // Validate passwords match
    const password = document.getElementById("registerPassword").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    if (password !== confirmPassword) {
      errorEl.textContent = "Passwords do not match";
      return;
    }

    btn.disabled = true;
    text.style.display = "none";
    spinner.classList.add("active");

    try {
      const response = await axios.post(`${API_BASE_URL}/auth/register`, {
        email: document.getElementById("registerEmail").value,
        password: password,
        name: document.getElementById("registerName").value,
        department: document.getElementById("registerDept").value,
      });

      // Show success and switch to login form
      const loginError = document.getElementById("loginError");
      loginError.innerHTML =
        '<div class="success-message">Registration successful! Please log in.</div>';

      // Switch back to login form
      document.getElementById("adminRegisterForm").style.display = "none";
      document.getElementById("loginForm").style.display = "block";

      // Clear the registration form
      document.getElementById("adminRegisterForm").reset();
    } catch (err) {
      errorEl.textContent =
        err.response?.data?.error || "Registration failed. Please try again.";
    } finally {
      btn.disabled = false;
      text.style.display = "inline";
      spinner.classList.remove("active");
    }
  });
