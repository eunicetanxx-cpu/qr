// ====== DOM Elements ======
const video = document.getElementById("video");
const canvasDisp = document.getElementById("display");
const ctxDisp = canvasDisp.getContext("2d", { willReadFrequently: true });
const overlayText = document.getElementById("overlayText");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");

// ====== Config ======
const SCAN_SIZE = 250;
let scanBox = { x: 0, y: 0, size: SCAN_SIZE };
let qrDecoderBusy = false;
let cvReady = false;
let animationFrameId;

// ====== Navigation State ======
let currentLocation = null;
let route = [];

// ====== Helpers ======
function speak(text) {
  if (!text) return;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ====== Reset Scanning ======
let foundResults = new Map();
let scanStartTime = Date.now();
const MAX_SCAN_TIME = 30000;

function resetScanning() {
  foundResults.clear();
  scanStartTime = Date.now();
  currentLocation = null;
  route = [];
  statusEl.textContent = "Scanning reset...";
  overlayText.textContent = "Looking for all color QR codes...";
  resultEl.innerHTML = "";
  console.log("🔄 Scanning reset - looking for all colors");
}

// ====== Camera ======
async function startCamera() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "environment" },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();

  canvasDisp.width = video.videoWidth;
  canvasDisp.height = video.videoHeight;

  scanBox.x = (canvasDisp.width - SCAN_SIZE) / 2;
  scanBox.y = (canvasDisp.height - SCAN_SIZE) / 2;

  resetScanning();
}

// ====== Navigation ======
function updateNavigation(color, decoded) {
  if (!qrData[color] || !qrData[color][decoded]) return;

  currentLocation = decoded;
  route.push(decoded);

  const info = qrData[color][decoded];

  // Update overlay
  overlayText.textContent = `Current: ${info.text}`;

  // TTS guidance
  if (info.voice) speak(info.voice);

  // Next step info
  if (info.next) {
    const nextInfo = qrData[color][info.next];
    if (nextInfo) {
      overlayText.textContent += ` → Next: ${nextInfo.text}`;
    }
  } else {
    overlayText.textContent += ` → End of route.`;
  }
}

// ====== QR Decoding ======
function tryDecodeAll() {
  if (qrDecoderBusy) return;
  qrDecoderBusy = true;

  let imageData = ctxDisp.getImageData(scanBox.x, scanBox.y, scanBox.size, scanBox.size);
  let newResults = [];
  let debugInfo = [];

  ["red", "green", "blue"].forEach(color => {
    if (foundResults.has(color)) return;

    try {
      // OpenCV method
      if (cvReady && !foundResults.has(color)) {
        try {
          let filteredImageData = preprocessWithOpenCV(imageData, color);
          const code = jsQR(filteredImageData.data, filteredImageData.width, filteredImageData.height, { inversionAttempts: "attemptBoth" });
          if (code && code.data) {
            const decoded = code.data.trim().replace(/\s+/g, "");
            debugInfo.push(`${color}-OpenCV: ${decoded}`);

            let resultData = { color, decoded, method: "OpenCV" };
            if (qrData[color] && qrData[color][decoded]) {
              resultData = { ...resultData, ...qrData[color][decoded] };
              updateNavigation(color, decoded); // Update navigation
            } else {
              resultData.text = `Unknown ${color.toUpperCase()} QR: ${decoded}`;
              resultData.voice = `Unknown ${color} QR code detected`;
            }

            foundResults.set(color, resultData);
            newResults.push(resultData);
          }
        } catch (cvError) {
          console.error(`OpenCV error for ${color}:`, cvError);
        }
      }

      // Channel method
      if (!foundResults.has(color)) {
        let channelImageData = extractColorChannel(imageData, color);
        const code = jsQR(channelImageData.data, channelImageData.width, channelImageData.height, { inversionAttempts: "attemptBoth" });
        if (code && code.data) {
          const decoded = code.data.trim().replace(/\s+/g, "");
          debugInfo.push(`${color}-Channel: ${decoded}`);

          let resultData = { color, decoded, method: "Channel" };
          if (qrData[color] && qrData[color][decoded]) {
            resultData = { ...resultData, ...qrData[color][decoded] };
            updateNavigation(color, decoded);
          } else {
            resultData.text = `Unknown ${color.toUpperCase()} QR: ${decoded}`;
            resultData.voice = `Unknown ${color} QR code detected`;
          }

          foundResults.set(color, resultData);
          newResults.push(resultData);
        }
      }
    } catch (error) {
      console.error(`Error processing ${color}:`, error);
    }
  });

  // Display status
  const foundColors = Array.from(foundResults.keys());
  const allResults = Array.from(foundResults.values());
  const scanTime = (Date.now() - scanStartTime) / 1000;

  if (foundColors.length === 0) {
    statusEl.textContent = `Scanning... (${scanTime.toFixed(1)}s)`;
  } else if (foundColors.length < 3) {
    const missing = ["red", "green", "blue"].filter(c => !foundColors.includes(c));
    statusEl.textContent = `Found ${foundColors.length}/3 colors - Missing: ${missing.join(', ')} (${scanTime.toFixed(1)}s)`;
    overlayText.textContent += `\nFound: ${foundColors.join(', ')}`;

    newResults.forEach(r => speak(`${r.color} QR found: ${r.voice || r.text}`));
  }

  if (allResults.length > 0) {
    resultEl.innerHTML = allResults.map(r =>
      `<div><b style="color:${r.color}">${r.color.toUpperCase()}:</b> ${r.text} <small>(${r.method})</small></div>`
    ).join("");
  }

  const shouldStop = foundColors.length === 3 || scanTime > MAX_SCAN_TIME;

  if (shouldStop) {
    if (foundColors.length === 3) {
      statusEl.textContent = "🎉 All colors decoded successfully!";
      overlayText.textContent = "Complete! All QR codes found.";
      speak("All QR codes successfully detected");
    } else {
      statusEl.textContent = `⏰ Scan timeout - Found ${foundColors.length}/3 colors`;
      overlayText.textContent = "Scan completed (timeout)";
      speak("Scan completed");
    }

    cancelAnimationFrame(animationFrameId);
    if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
  }

  setTimeout(() => { qrDecoderBusy = false; }, 100);
}

// ====== RGB Channel Extraction ======
function extractColorChannel(imageData, color) {
  const data = new Uint8ClampedArray(imageData.data);
  let pixelCount = 0, colorPixels = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    pixelCount++;

    if (color === "red") {
      const intensity = r; if (r > g && r > b && r > 50) colorPixels++;
      data[i] = data[i+1] = data[i+2] = intensity;
    } else if (color === "green") {
      const intensity = g; if (g > r && g > b && g > 50) colorPixels++;
      data[i] = data[i+1] = data[i+2] = intensity;
    } else if (color === "blue") {
      const intensity = b; if (b > r && b > g && b > 50) colorPixels++;
      data[i] = data[i+1] = data[i+2] = intensity;
    }
  }

  return new ImageData(data, imageData.width, imageData.height);
}

// ====== OpenCV Preprocessing ======
function preprocessWithOpenCV(imageData, color) {
  if (!cvReady) return imageData;

  const src = cv.matFromImageData(imageData);
  let processed = new cv.Mat();
  cv.cvtColor(src, processed, cv.COLOR_RGBA2RGB);
  cv.cvtColor(processed, processed, cv.COLOR_RGB2HSV);

  let mask = new cv.Mat();
  let low, high;

  if (color === "red") {
    let mask1 = new cv.Mat(), mask2 = new cv.Mat();
    low = new cv.Scalar(0,50,50); high = new cv.Scalar(15,255,255); cv.inRange(processed, low, high, mask1);
    low = new cv.Scalar(165,50,50); high = new cv.Scalar(180,255,255); cv.inRange(processed, low, high, mask2);
    cv.add(mask1, mask2, mask); mask1.delete(); mask2.delete();
  } else if (color === "green") {
    low = new cv.Scalar(40,40,40); high = new cv.Scalar(80,255,255); cv.inRange(processed, low, high, mask);
  } else if (color === "blue") {
    low = new cv.Scalar(100,40,40); high = new cv.Scalar(130,255,255); cv.inRange(processed, low, high, mask);
  }

  let kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3,3));
  cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
  cv.morphologyEx(mask, mask, cv.MORPH_OPEN, kernel);
  kernel.delete();

  let rgba = new cv.Mat();
  cv.cvtColor(mask, rgba, cv.COLOR_GRAY2RGBA);
  const out = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);

  src.delete(); processed.delete(); mask.delete(); rgba.delete();
  return out;
}

// ====== Main Loop ======
function processFrame() {
  animationFrameId = requestAnimationFrame(processFrame);
  ctxDisp.drawImage(video, 0, 0, canvasDisp.width, canvasDisp.height);

  ctxDisp.strokeStyle = "yellow";
  ctxDisp.lineWidth = 3;
  ctxDisp.strokeRect(scanBox.x, scanBox.y, scanBox.size, scanBox.size);

  tryDecodeAll();
}

// ====== OpenCV Ready ======
function onOpenCVReady() {
  cvReady = true;
  console.log("OpenCV ready");
  statusEl.textContent = "OpenCV loaded - Enhanced color detection enabled";
}

// ====== Restart Scanning ======
async function restartScanning() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (video.srcObject) video.srcObject.getTracks().forEach(track => track.stop());
  resetScanning();
  await startCamera();
  statusEl.textContent = "🔄 Scanning restarted";
  processFrame();
}

// ====== Initialize ======
document.addEventListener("DOMContentLoaded", async () => {
  statusEl.textContent = "Initializing...";
  if (typeof jsQR === 'undefined') { statusEl.textContent = "❌ jsQR not loaded"; return; }
  if (typeof qrData === 'undefined') { statusEl.textContent = "❌ QR data missing"; return; }

  let opencvTimeout = setTimeout(() => {
    console.warn("OpenCV loading timeout");
    statusEl.textContent = "OpenCV timeout - using basic detection";
  }, 10000);

  if (window.cv) {
    if (cv.Mat) { clearTimeout(opencvTimeout); onOpenCVReady(); }
    else cv.onRuntimeInitialized = () => { clearTimeout(opencvTimeout); onOpenCVReady(); };
  } else {
    const checkCV = setInterval(() => {
      if (window.cv && cv.Mat) { clearInterval(checkCV); clearTimeout(opencvTimeout); onOpenCVReady(); }
    }, 100);
  }

  statusEl.textContent = "Starting camera...";
  overlayText.textContent = "Initializing camera...";

  try {
    await startCamera();
    statusEl.textContent = cvReady ? "✅ Ready - Enhanced detection" : "⚠️ Ready - Basic detection only";
    overlayText.textContent = "Scanning for QR codes...";
    processFrame();
  } catch (error) {
    statusEl.textContent = "❌ Camera access denied"; console.error(error);
  }

  window.restartScan = restartScanning;
});

document.addEventListener("DOMContentLoaded", async () => {
  statusEl.textContent = "Initializing...";

  if (typeof jsQR === 'undefined') { statusEl.textContent = "❌ jsQR not loaded"; return; }
  if (typeof qrData === 'undefined') { statusEl.textContent = "❌ QR data missing"; return; }

  // OpenCV initialization (keep your existing logic)
  let opencvTimeout = setTimeout(() => {
    console.warn("OpenCV loading timeout");
    statusEl.textContent = "OpenCV timeout - using basic detection";
  }, 10000);

  if (window.cv) {
    if (cv.Mat) { clearTimeout(opencvTimeout); onOpenCVReady(); }
    else cv.onRuntimeInitialized = () => { clearTimeout(opencvTimeout); onOpenCVReady(); };
  } else {
    const checkCV = setInterval(() => {
      if (window.cv && cv.Mat) { clearInterval(checkCV); clearTimeout(opencvTimeout); onOpenCVReady(); }
    }, 100);
  }

  // Auto-start camera
  try {
    await startCamera();        // <-- this will open the camera automatically
    statusEl.textContent = cvReady ? "✅ Ready - Enhanced detection" : "⚠️ Ready - Basic detection only";
    overlayText.textContent = "Scanning for QR codes...";
    processFrame();
  } catch (error) {
    statusEl.textContent = "❌ Camera access denied";
    console.error("Camera error:", error);
  }

  window.restartScan = restartScanning; // Keep restart function
});

