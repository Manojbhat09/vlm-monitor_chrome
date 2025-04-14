// Constants
const STATUS = {
  IDLE: 'idle',
  ACTIVE: 'active',
  PROCESSING: 'processing',
  WARNING: 'warning',
  ERROR: 'error'
};

const STORAGE_KEYS = {
  SETTINGS: 'ai_watcher_settings',
  SESSIONS: 'ai_watcher_sessions',
  RESPONSES: 'ai_watcher_responses',
  IMAGES: 'ai_watcher_images',
  DEBUG: 'ai_watcher_debug'
};

// Default settings
const DEFAULT_SETTINGS = {
  captureMethod: 'crop',
  vlmModel: 'anthropic/claude-3-haiku',
  monitorInterval: 30,
  enableNotifications: true,
  autoBackoff: true,
  apiKey: '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',
  debugMode: false,
  showPixelOverlay: false
};

// Global variables
let currentStatus = STATUS.IDLE;
let selectedArea = null;
let capturedImage = null;
let currentSession = null;
let sessionTimer = null;
let pixelCounter = {
  width: 0,
  height: 0,
  total: 0
};

// Cost estimator per 1000 pixels (approximate)
const COST_ESTIMATES = {
  'anthropic/claude-3-haiku': 0.000015,
  'google/gemini-pro-vision': 0.000010,
  'openai/gpt-4-vision': 0.000030
};

// DOM elements
const domElements = {};

// Initialize when DOM content is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Cache DOM elements
  cacheElements();
  
  // Initialize Bootstrap tabs
  const triggerTabList = [].slice.call(document.querySelectorAll('#mainTabs button'));
  triggerTabList.forEach(function (triggerEl) {
    const tabTrigger = new bootstrap.Tab(triggerEl);

    triggerEl.addEventListener('click', function (event) {
      event.preventDefault();
      tabTrigger.show();
    });
  });
  
  // Check for any cached messages from background
  checkCachedMessages();
  
  // Request current state from background
  requestCurrentState();
  
  // Load settings
  loadSettings();
  
  // Load UI state from storage
  loadUIState();
  
  // Initialize UI (basic setup, state will be applied after response)
  initUI();
  
  // Attach event listeners
  attachEventListeners();
  
  // Listen for messages from background or content scripts
  chrome.runtime.onMessage.addListener(handleMessages);
});

// Cache DOM elements for faster access
function cacheElements() {
  // Status
  domElements.statusIndicator = document.getElementById('statusIndicator');
  domElements.statusText = document.getElementById('statusText');
  
  // Capture tab
  domElements.captureViewport = document.getElementById('captureViewport');
  domElements.captureArea = document.getElementById('captureArea');
  domElements.testAutoCaptureAnalyze = document.getElementById('testAutoCaptureAnalyze');
  domElements.selectionInfo = document.getElementById('selectionInfo');
  domElements.dimensionsText = document.getElementById('dimensionsText');
  domElements.pixelsText = document.getElementById('pixelsText');
  domElements.costText = document.getElementById('costText');
  domElements.vlmModel = document.getElementById('vlmModel');
  domElements.promptText = document.getElementById('promptText');
  domElements.analyzeImage = document.getElementById('analyzeImage');
  domElements.previewContainer = document.getElementById('previewContainer');
  domElements.previewImage = document.getElementById('previewImage');
  domElements.responseContainer = document.getElementById('responseContainer');
  domElements.responseText = document.getElementById('responseText');
  
  // Monitor tab
  domElements.monitorInterval = document.getElementById('monitorInterval');
  domElements.enableNotifications = document.getElementById('enableNotifications');
  domElements.autoBackoff = document.getElementById('autoBackoff');
  domElements.sessionStatus = document.getElementById('sessionStatus');
  domElements.startSession = document.getElementById('startSession');
  domElements.pauseSession = document.getElementById('pauseSession');
  domElements.stopSession = document.getElementById('stopSession');
  domElements.sessionStartTime = document.getElementById('sessionStartTime');
  domElements.sessionDuration = document.getElementById('sessionDuration');
  domElements.captureCount = document.getElementById('captureCount');
  domElements.lastCaptureTime = document.getElementById('lastCaptureTime');
  domElements.apiCallCount = document.getElementById('apiCallCount');
  domElements.rateLimitCount = document.getElementById('rateLimitCount');
  
  // History tab
  domElements.sessionFilter = document.getElementById('sessionFilter');
  domElements.refreshHistory = document.getElementById('refreshHistory');
  domElements.clearHistory = document.getElementById('clearHistory');
  domElements.historyTableBody = document.getElementById('historyTableBody');
  
  // Dev tab
  domElements.enableDebugMode = document.getElementById('enableDebugMode');
  domElements.showPixelOverlay = document.getElementById('showPixelOverlay');
  domElements.testCapture = document.getElementById('testCapture');
  domElements.testAPIConnection = document.getElementById('testAPIConnection');
  domElements.viewLogs = document.getElementById('viewLogs');
  domElements.apiEndpoint = document.getElementById('apiEndpoint');
  domElements.apiKey = document.getElementById('apiKey');
  domElements.toggleApiKey = document.getElementById('toggleApiKey');
  domElements.apiPayload = document.getElementById('apiPayload');
  domElements.sendApiRequest = document.getElementById('sendApiRequest');
  domElements.apiResponse = document.getElementById('apiResponse');
  domElements.storageType = document.getElementById('storageType');
  domElements.storageData = document.getElementById('storageData');
  domElements.storageUsage = document.getElementById('storageUsage');
  domElements.refreshStorage = document.getElementById('refreshStorage');
  domElements.exportStorage = document.getElementById('exportStorage');
  domElements.clearStorage = document.getElementById('clearStorage');
}

// Initialize UI based on settings
function initUI() {
  // Set status
  updateStatus(STATUS.IDLE, 'Ready');
  
  // Update storage usage
  updateStorageUsage();
  
  // Populate history sessions
  loadSessionsIntoFilter();
  
  // Load history data
  loadHistoryData();
}

// Request current state from background script
function requestCurrentState() {
  log('Requesting current state from background');
  chrome.runtime.sendMessage({ action: 'getCurrentState' }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error requesting state:', chrome.runtime.lastError);
      updateStatus(STATUS.ERROR, 'Error connecting to background');
      return;
    }
    log('Received current state:', response);
    if (response && response.state) {
      // Apply state to UI
      applyState(response.state);
    } else {
      log('No state received or invalid response', response);
      
      // Force refresh of captured image from background state after 500ms
      // This helps in cases where the popup re-opens after selection
      setTimeout(() => {
        chrome.runtime.sendMessage({ action: 'getCurrentState' }, (refreshResponse) => {
          if (refreshResponse && refreshResponse.state && refreshResponse.state.capturedImage) {
            log('Received refreshed state with captured image');
            handleCaptureComplete(refreshResponse.state.capturedImage, false);
          }
        });
      }, 500);
    }
  });
}

// Apply state received from background script
function applyState(state) {
  log('Applying state to UI:', state);
  if (state.status) {
    updateStatus(state.status.type, state.status.message);
  }
  if (state.selectedArea) {
    handleAreaSelected(state.selectedArea); // Reuse existing handler
  }
  if (state.capturedImage) {
    handleCaptureComplete(state.capturedImage, false); // Reuse handler, don't re-analyze
  } else {
    log('No captured image in state, checking background state again');
    // Double check for captured image
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'getCurrentState' }, (refreshResponse) => {
        if (refreshResponse?.state?.capturedImage) {
          handleCaptureComplete(refreshResponse.state.capturedImage, false);
        }
      });
    }, 300);
  }
  if (state.currentSession) {
    currentSession = state.currentSession;
    updateSessionUI();
    if (currentSession.status === 'active') {
      startSessionTimer();
    }
  } else {
    currentSession = null;
    updateSessionUI();
  }
}

// Load settings from storage
function loadSettings() {
  chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
    const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
    
    // Apply settings to UI
    if (domElements.vlmModel) domElements.vlmModel.value = settings.vlmModel;
    if (domElements.monitorInterval) domElements.monitorInterval.value = settings.monitorInterval;
    if (domElements.enableNotifications) domElements.enableNotifications.checked = settings.enableNotifications;
    if (domElements.autoBackoff) domElements.autoBackoff.checked = settings.autoBackoff;
    if (domElements.enableDebugMode) domElements.enableDebugMode.checked = settings.debugMode;
    if (domElements.showPixelOverlay) domElements.showPixelOverlay.checked = settings.showPixelOverlay;
    if (domElements.apiKey) domElements.apiKey.value = settings.apiKey || '';
    
    // Apply developer settings
    if (settings.debugMode) {
      document.body.classList.add('debug-mode');
    }
  });
}

// Save settings to storage
function saveSettings() {
  // Get API key, using default if empty
  let apiKey = domElements.apiKey.value.trim();
  if (!apiKey) {
    apiKey = DEFAULT_SETTINGS.apiKey;
    // Update UI with default key
    domElements.apiKey.value = apiKey;
  }

  const settings = {
    vlmModel: domElements.vlmModel.value,
    monitorInterval: parseInt(domElements.monitorInterval.value, 10),
    enableNotifications: domElements.enableNotifications.checked,
    autoBackoff: domElements.autoBackoff.checked,
    debugMode: domElements.enableDebugMode.checked,
    showPixelOverlay: domElements.showPixelOverlay.checked,
    apiKey: apiKey
  };
  
  chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings }, () => {
    if (settings.debugMode) {
      console.log('Settings saved:', settings);
    }
  });
  
  return settings;
}

// Update status indicator
function updateStatus(status, message) {
  currentStatus = status;
  const statusText = message || status.charAt(0).toUpperCase() + status.slice(1);

  // Update status dot
  if (domElements.statusIndicator) {
    const statusDot = domElements.statusIndicator.querySelector('.status-dot');
    if (statusDot) {
        statusDot.className = 'status-dot'; // Reset classes
        statusDot.classList.add(status);
    }
  }

  // Update status text
  if (domElements.statusText) {
      domElements.statusText.textContent = statusText;
  }

  // Send status update to background if needed (optional)
  // chrome.runtime.sendMessage({ action: 'updateBackgroundStatus', status: { type: status, message: statusText } });
  log('Status updated:', { status, message });
}

// Attach event listeners
function attachEventListeners() {
  // Capture tab
  domElements.captureViewport.addEventListener('click', handleCaptureViewport);
  domElements.captureArea.addEventListener('click', handleCaptureArea);
  domElements.testAutoCaptureAnalyze.addEventListener('click', handleTestAutoCaptureAnalyze);
  domElements.vlmModel.addEventListener('change', (e) => {
    saveSettings();
    saveUIState(); // Save UI state when model changes
  });
  domElements.promptText.addEventListener('input', (e) => {
    saveUIState(); // Save UI state when prompt changes
  });
  domElements.analyzeImage.addEventListener('click', handleAnalyzeImage);
  
  // Monitor tab
  domElements.monitorInterval.addEventListener('change', saveSettings);
  domElements.enableNotifications.addEventListener('change', saveSettings);
  domElements.autoBackoff.addEventListener('change', saveSettings);
  domElements.startSession.addEventListener('click', handleStartSession);
  domElements.pauseSession.addEventListener('click', handlePauseSession);
  domElements.stopSession.addEventListener('click', handleStopSession);
  
  // History tab
  domElements.sessionFilter.addEventListener('change', handleFilterChange);
  domElements.refreshHistory.addEventListener('click', loadHistoryData);
  domElements.clearHistory.addEventListener('click', handleClearHistory);
  
  // Dev tab
  domElements.enableDebugMode.addEventListener('change', saveSettings);
  domElements.showPixelOverlay.addEventListener('change', saveSettings);
  domElements.testCapture.addEventListener('click', handleTestCapture);
  domElements.testAPIConnection.addEventListener('click', handleTestAPIConnection);
  domElements.viewLogs.addEventListener('click', handleViewLogs);
  domElements.toggleApiKey.addEventListener('click', () => {
    const apiKeyField = domElements.apiKey;
    apiKeyField.type = apiKeyField.type === 'password' ? 'text' : 'password';
    domElements.toggleApiKey.innerHTML = apiKeyField.type === 'password' ? '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
  });
  domElements.sendApiRequest.addEventListener('click', handleSendApiRequest);
  domElements.storageType.addEventListener('change', handleRefreshStorage);
  domElements.refreshStorage.addEventListener('click', handleRefreshStorage);
  domElements.exportStorage.addEventListener('click', handleExportStorage);
  domElements.clearStorage.addEventListener('click', handleClearStorage);
  
  // Save settings when API key changes
  domElements.apiKey.addEventListener('change', saveSettings);
}

// Handle messages from background or content scripts
function handleMessages(message, sender, sendResponse) {
  log('Popup received message:', message);
  try {
      if (message.action === 'areaSelected') {
        handleAreaSelected(message.data);
        sendResponse({ success: true });
      } else if (message.action === 'captureComplete') {
        // Don't re-analyze if it's just restoring state
        handleCaptureComplete(message.data, message.analyze !== false);
        sendResponse({ success: true });
      } else if (message.action === 'analyzeComplete') {
        handleAnalyzeComplete(message.data);
        sendResponse({ success: true });
      } else if (message.action === 'updateStatus') {
        updateStatus(message.status, message.message);
        sendResponse({ success: true });
      } else if (message.action === 'rateLimitHit') {
        handleRateLimit(message.data);
        sendResponse({ success: true });
      } else if (message.action === 'sessionUpdate') {
        currentSession = message.session;
        updateSessionUI();
        if (currentSession?.status === 'active' && !sessionTimer) {
            startSessionTimer();
        } else if (currentSession?.status !== 'active' && sessionTimer) {
            stopSessionTimer();
        }
        sendResponse({ success: true });
      } else if (message.action === 'debugLog') {
        if (domElements.enableDebugMode?.checked) {
          console.log('[Debug]', message.data);
        }
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'Unknown action in popup' });
      }
  } catch (error) {
      log('Error handling message in popup:', error, message);
      sendResponse({ success: false, error: error.message });
  }

  return true; // Keep the message channel open for async response
}

// Handle capture viewport button click
function handleCaptureViewport() {
  updateStatus(STATUS.PROCESSING, 'Capturing viewport...');
  
  chrome.runtime.sendMessage({
    action: 'captureViewport'
  }, (response) => {
    if (response && response.success) {
      log('Viewport capture initiated');
    } else {
      updateStatus(STATUS.ERROR, 'Failed to capture viewport');
      log('Viewport capture failed', response?.error);
    }
  });
}

// Handle capture area button click
function handleCaptureArea() {
  updateStatus(STATUS.PROCESSING, 'Initiating area selection...');

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      updateStatus(STATUS.ERROR, 'Could not find active tab. Make sure you\'re on a webpage.');
      log('No active tab found in handleCaptureArea, tabs:', tabs);
      return;
    }
    
    const activeTab = tabs[0];
    
    if (!activeTab.id) {
      updateStatus(STATUS.ERROR, 'Invalid tab ID. Try refreshing the page.');
      log('Invalid tab ID in handleCaptureArea, activeTab:', activeTab);
      return;
    }

    // Send message with the tab info
    chrome.runtime.sendMessage({ 
      action: 'startSelection',
      tabId: activeTab.id,
      windowId: activeTab.windowId
    }, (response) => {
      if (response && response.success) {
        log('Area selection successfully initiated by background');
        updateStatus(STATUS.ACTIVE, 'Select area on the page...');
      } else {
        updateStatus(STATUS.ERROR, 'Failed to start selection');
        log('Failed to initiate area selection', response?.error);
      }
    });
  });
}

// Handle area selected from content script
function handleAreaSelected(data) {
  selectedArea = data;
  pixelCounter = {
    width: data.width,
    height: data.height,
    total: data.width * data.height
  };
  
  // Update UI
  domElements.selectionInfo.style.display = 'block';
  domElements.dimensionsText.textContent = `${data.width} x ${data.height} px`;
  domElements.pixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
  
  // Calculate cost estimate
  const costPerPixel = COST_ESTIMATES[domElements.vlmModel.value] || 0.00001;
  const estimatedCost = (pixelCounter.total / 1000) * costPerPixel;
  domElements.costText.textContent = `$${estimatedCost.toFixed(6)}`;
  
  // Enable analyze button
  domElements.analyzeImage.disabled = false;
  
  updateStatus(STATUS.ACTIVE, 'Area selected. Preview will appear after capture completes.');
  
  log('Area selection recorded in popup', data);
  // Note: The captureViewportArea is now called automatically in the background
}

// Handle analyze image button click
function handleAnalyzeImage() {
  const imageToAnalyze = capturedImage;

  log('handleAnalyzeImage called', { 
    hasCapturedImage: !!imageToAnalyze,
    hasDataUrl: imageToAnalyze?.dataUrl ? true : false,
    dataUrlLength: imageToAnalyze?.dataUrl?.length || 0
  });

  if (!imageToAnalyze?.dataUrl) {
    updateStatus(STATUS.WARNING, 'No captured image available');
    // Try to get the image from background state as a last resort
    chrome.runtime.sendMessage({ action: 'getCurrentState' }, (response) => {
      if (response?.state?.capturedImage?.dataUrl) {
        log('Retrieved capturedImage from background state', {
          dataUrlLength: response.state.capturedImage.dataUrl.length
        });
        // Use the image from background state
        capturedImage = response.state.capturedImage;
        // Now try analyzing again
        setTimeout(handleAnalyzeImage, 100);
      } else {
        log('No captured image available in background state either');
      }
    });
    return;
  }

  const prompt = domElements.promptText.value.trim();
  if (!prompt) {
    updateStatus(STATUS.WARNING, 'Please enter a prompt');
    return;
  }

  updateStatus(STATUS.PROCESSING, 'Preparing analysis...');

  // Disable analyze button
  domElements.analyzeImage.disabled = true;

  log('Sending image for analysis', { promptLength: prompt.length });
  // We have a captured image, analyze it directly
  sendImageForAnalysis(imageToAnalyze, prompt);
}

// Handle capture complete from content or background script
function handleCaptureComplete(data, shouldAnalyze = true) {
  log('Capture complete received in popup', { 
    hasData: !!data, 
    hasDataUrl: data && !!data.dataUrl,
    timestamp: data?.timestamp 
  });
  
  if (!data || !data.dataUrl) {
    log('Warning: Capture complete message received without valid image data');
    updateStatus(STATUS.WARNING, 'Capture completed but no valid image received');
    return;
  }
  
  capturedImage = data; // Store the captured image data { dataUrl, timestamp }
  
  // Update UI with the image
  if (domElements.previewContainer) {
    domElements.previewContainer.style.display = 'block';
  }
  
  // Hide the response container if visible
  if (domElements.responseContainer) {
    domElements.responseContainer.style.display = 'none';
  }
  
  if (domElements.previewImage) {
    // Set the src and add an onload handler to verify image loads properly
    domElements.previewImage.onload = function() {
      log('Preview image loaded successfully');
      updateStatus(STATUS.ACTIVE, 'Image captured and ready for analysis');
      
      // Check if we're in auto test mode
      const inAutoTestMode = localStorage.getItem('autoTestMode') === 'true';
      if (inAutoTestMode) {
        localStorage.removeItem('autoTestMode'); // Clear the flag
        log('Auto test mode detected - automatically analyzing image');
        setTimeout(() => {
          handleAnalyzeImage();
        }, 500); // Short delay to let UI update
      }
    };
    
    domElements.previewImage.onerror = function() {
      log('Error loading preview image', { dataUrlLength: data.dataUrl.length });
      updateStatus(STATUS.ERROR, 'Error displaying captured image');
    };
    
    // Actually set the image src
    domElements.previewImage.src = data.dataUrl;
  }
  
  // Hide selection info once we have an image
  if (domElements.selectionInfo) {
    domElements.selectionInfo.style.display = 'none';
  }
  
  // Enable analyze button
  if (domElements.analyzeImage) {
    domElements.analyzeImage.disabled = false;
  }

  // If this capture was triggered for analysis, proceed
  const prompt = domElements.promptText?.value.trim();
  if (shouldAnalyze && prompt) {
    log('Proceeding to analyze captured image.');
    sendImageForAnalysis(capturedImage, prompt);
  }
}

// Send image for analysis to the VLM API (sends message to background)
function sendImageForAnalysis(imageData, prompt) {
  updateStatus(STATUS.PROCESSING, 'Sending to API...');

  // Prepare API request
  const settings = saveSettings(); // Ensure latest settings are used
  
  // Ensure there's always an API key - if empty, fall back to default
  let apiKey = settings.apiKey.trim();
  if (!apiKey) {
    apiKey = DEFAULT_SETTINGS.apiKey;
    log('Using default API key for request');
  }

  const modelId = settings.vlmModel;

  // Estimate pixel count from image data if not available
  let imageSize = pixelCounter.total > 0 ? pixelCounter : { width: 0, height: 0, total: 0 };

  // Construct the payload (simplified, background handles details)
  let payload = {
      model: modelId,
      prompt: prompt,
      imageDataUrl: imageData.dataUrl
  };

  // Send to background script to handle the API request construction and call
  chrome.runtime.sendMessage({
    action: 'analyzeImage',
    payload: payload,
    apiKey: apiKey,
    metadata: {
      prompt: prompt,
      imageSize: imageSize, // Send estimated size
      timestamp: new Date().toISOString(),
      sessionId: currentSession?.id || null
    }
  }, (response) => {
    if (response && response.success) {
      log('API analysis request sent successfully');
    } else {
      updateStatus(STATUS.ERROR, response?.error || 'API request failed');
      domElements.analyzeImage.disabled = false;
      log('API analysis request failed', response?.error);
    }
  });
}

// Handle analyze complete from background script
function handleAnalyzeComplete(data) {
  // Enable analyze button
  if (domElements.analyzeImage) domElements.analyzeImage.disabled = false;

  if (data.error) {
    updateStatus(STATUS.ERROR, data.error.message || 'Analysis failed');
    log('Analysis failed', data.error);
    return;
  }

  updateStatus(STATUS.ACTIVE, 'Analysis complete');

  // Get the response object from the data
  const response = data.response;
  if (!response) {
    log('No response data received');
    return;
  }

  // Show response data in UI
  showResponseInUI(response);
}

// Helper function to inject content script if not already loaded
function injectContentScript(tabId, callback) {
  chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/index.js']
  }, () => {
    chrome.scripting.insertCSS({
      target: { tabId },
      files: ['content/index.css']
    }, callback);
  });
}

// Helper function for logging
function log(message, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    data
  };
  
  // Store in debug logs
  chrome.storage.local.get([STORAGE_KEYS.DEBUG], (result) => {
    const logs = result[STORAGE_KEYS.DEBUG] || [];
    logs.push(logEntry);
    
    // Keep only the last 100 logs
    if (logs.length > 100) {
      logs.splice(0, logs.length - 100);
    }
    
    chrome.storage.local.set({ [STORAGE_KEYS.DEBUG]: logs });
  });
  
  // If debug mode is enabled, also log to console
  if (domElements.enableDebugMode?.checked) {
    console.log(`[${new Date().toLocaleTimeString()}] ${message}`, data || '');
  }
}

// Generate a unique ID
function generateId() {
  return 'id_' + Math.random().toString(36).substr(2, 9);
}

// Format time
function formatTime(date) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// Format datetime
function formatDateTime(date) {
  return date.toLocaleString([], { 
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Check for any ongoing monitoring session
function checkOngoingSession() {
  chrome.storage.local.get([STORAGE_KEYS.SESSIONS], (result) => {
    const sessions = result[STORAGE_KEYS.SESSIONS] || [];
    
    // Look for any active session
    const activeSession = sessions.find(session => session.status === 'active');
    
    if (activeSession) {
      // Resume active session
      currentSession = activeSession;
      
      // Update UI
      updateSessionUI();
      
      // Resume session timer
      startSessionTimer();
      
      // Check if we need to recreate the alarm
      checkMonitoringAlarm();
    }
  });
}

// Update session UI based on current session
function updateSessionUI() {
  if (!currentSession) {
    domElements.sessionStatus.textContent = 'Inactive';
    domElements.sessionStatus.className = 'badge bg-secondary';
    domElements.startSession.disabled = false;
    domElements.pauseSession.disabled = true;
    domElements.stopSession.disabled = true;
    domElements.sessionStartTime.textContent = '--';
    domElements.sessionDuration.textContent = '00:00:00';
    domElements.captureCount.textContent = '0';
    domElements.lastCaptureTime.textContent = '--';
    domElements.apiCallCount.textContent = '0';
    domElements.rateLimitCount.textContent = '0';
    return;
  }
  
  // Set session status badge
  domElements.sessionStatus.textContent = currentSession.status === 'active' ? 'Active' : 
    currentSession.status === 'paused' ? 'Paused' : 'Completed';
  
  domElements.sessionStatus.className = currentSession.status === 'active' ? 'badge bg-success' : 
    currentSession.status === 'paused' ? 'badge bg-warning' : 'badge bg-danger';
  
  // Set button states
  domElements.startSession.disabled = currentSession.status === 'active';
  domElements.pauseSession.disabled = currentSession.status !== 'active';
  domElements.stopSession.disabled = currentSession.status === 'completed';
  
  // Update session stats
  domElements.sessionStartTime.textContent = formatTime(new Date(currentSession.startTime));
  domElements.captureCount.textContent = currentSession.captureCount.toString();
  domElements.apiCallCount.textContent = currentSession.apiCallCount.toString();
  domElements.rateLimitCount.textContent = currentSession.rateLimitCount.toString();
  
  if (currentSession.lastCaptureTime) {
    domElements.lastCaptureTime.textContent = formatTime(new Date(currentSession.lastCaptureTime));
  } else {
    domElements.lastCaptureTime.textContent = '--';
  }
}

// Start a new monitoring session
function handleStartSession() {
  // If there's a paused session, resume it
  if (currentSession && currentSession.status === 'paused') {
    currentSession.status = 'active';
    currentSession.resumeTime = new Date().toISOString();
    
    // Save session
    saveSession(currentSession);
    
    // Update UI
    updateSessionUI();
    
    // Resume session timer
    startSessionTimer();
    
    // Start monitoring alarm
    startMonitoringAlarm();
    
    updateStatus(STATUS.ACTIVE, 'Session resumed');
    return;
  }
  
  // Create a new session
  currentSession = {
    id: generateId(),
    status: 'active',
    startTime: new Date().toISOString(),
    endTime: null,
    duration: 0,
    captureCount: 0,
    apiCallCount: 0,
    rateLimitCount: 0,
    lastCaptureTime: null,
    settings: saveSettings()
  };
  
  // Save session
  saveSession(currentSession);
  
  // Update UI
  updateSessionUI();
  
  // Start session timer
  startSessionTimer();
  
  // Start monitoring alarm
  startMonitoringAlarm();
  
  updateStatus(STATUS.ACTIVE, 'Session started');
  
  // Add session to filter
  addSessionToFilter(currentSession);
}

// Pause current monitoring session
function handlePauseSession() {
  if (!currentSession || currentSession.status !== 'active') {
    return;
  }
  
  // Pause session
  currentSession.status = 'paused';
  currentSession.pauseTime = new Date().toISOString();
  
  // Save session
  saveSession(currentSession);
  
  // Update UI
  updateSessionUI();
  
  // Stop session timer
  stopSessionTimer();
  
  // Stop monitoring alarm
  stopMonitoringAlarm();
  
  updateStatus(STATUS.IDLE, 'Session paused');
}

// Stop current monitoring session
function handleStopSession() {
  if (!currentSession || currentSession.status === 'completed') {
    return;
  }
  
  // Complete session
  currentSession.status = 'completed';
  currentSession.endTime = new Date().toISOString();
  
  // Calculate total duration
  if (sessionTimer) {
    currentSession.duration = getSessionDuration();
  }
  
  // Save session
  saveSession(currentSession);
  
  // Update UI
  updateSessionUI();
  
  // Stop session timer
  stopSessionTimer();
  
  // Stop monitoring alarm
  stopMonitoringAlarm();
  
  updateStatus(STATUS.IDLE, 'Session completed');
  
  // Clear current session
  currentSession = null;
}

// Start the session timer
function startSessionTimer() {
  if (sessionTimer) {
    clearInterval(sessionTimer);
  }
  
  sessionTimer = setInterval(() => {
    if (currentSession && currentSession.status === 'active') {
      const duration = getSessionDuration();
      domElements.sessionDuration.textContent = formatDuration(duration);
    }
  }, 1000);
}

// Stop the session timer
function stopSessionTimer() {
  if (sessionTimer) {
    clearInterval(sessionTimer);
    sessionTimer = null;
  }
}

// Get session duration in seconds
function getSessionDuration() {
  if (!currentSession) return 0;
  
  const now = new Date();
  const startTime = new Date(currentSession.startTime);
  let totalDuration = Math.floor((now - startTime) / 1000);
  
  // Subtract paused time
  if (currentSession.pauseTime && currentSession.resumeTime) {
    const pauseTime = new Date(currentSession.pauseTime);
    const resumeTime = new Date(currentSession.resumeTime);
    const pausedDuration = Math.floor((resumeTime - pauseTime) / 1000);
    totalDuration -= pausedDuration;
  }
  
  return totalDuration;
}

// Format duration as HH:MM:SS
function formatDuration(seconds) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  return [
    hours.toString().padStart(2, '0'),
    minutes.toString().padStart(2, '0'),
    secs.toString().padStart(2, '0')
  ].join(':');
}

// Check if there's an existing monitoring alarm
function checkMonitoringAlarm() {
  chrome.alarms.get('monitoring', (alarm) => {
    if (!alarm && currentSession && currentSession.status === 'active') {
      // Recreate the alarm
      startMonitoringAlarm();
    }
  });
}

// Start the monitoring alarm
function startMonitoringAlarm() {
  const settings = saveSettings();
  const intervalSeconds = Math.max(10, settings.monitorInterval);
  
  // Create alarm
  chrome.alarms.create('monitoring', {
    delayInMinutes: intervalSeconds / 60,
    periodInMinutes: intervalSeconds / 60
  });
  
  // Listen for alarm
  chrome.alarms.onAlarm.addListener(handleAlarm);
  
  log(`Monitoring alarm created with interval: ${intervalSeconds} seconds`);
}

// Update the monitoring alarm interval
function updateMonitoringAlarm() {
  stopMonitoringAlarm();
  startMonitoringAlarm();
}

// Stop the monitoring alarm
function stopMonitoringAlarm() {
  chrome.alarms.clear('monitoring');
  chrome.alarms.onAlarm.removeListener(handleAlarm);
  
  log('Monitoring alarm cleared');
}

// Handle alarm event
function handleAlarm(alarm) {
  if (alarm.name === 'monitoring') {
    // Check if session is still active
    if (currentSession && currentSession.status === 'active') {
      // Trigger a capture
      captureForMonitoring();
    } else {
      // Stop the alarm if session is not active
      stopMonitoringAlarm();
    }
  }
}

// Capture the screen for monitoring
function captureForMonitoring() {
  log('Automatic capture triggered by monitoring alarm');
  
  // If we have a selected area, use that, otherwise capture the viewport
  if (selectedArea) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: 'captureArea',
          area: selectedArea
        });
      }
    });
  } else {
    chrome.runtime.sendMessage({
      action: 'captureViewport'
    });
  }
}

// Handle rate limit detection
function handleRateLimit(data) {
  if (currentSession) {
    currentSession.rateLimitCount++;
    domElements.rateLimitCount.textContent = currentSession.rateLimitCount.toString();
    
    // Save updated session
    saveSession(currentSession);
  }
  
  updateStatus(STATUS.WARNING, 'Rate limit hit');
  
  log('Rate limit detected', data);
  
  // If auto-backoff is enabled, pause monitoring temporarily
  if (domElements.autoBackoff.checked && currentSession && currentSession.status === 'active') {
    // Stop the alarm
    stopMonitoringAlarm();
    
    // Calculate backoff time (exponential backoff based on number of rate limits)
    const backoffTime = Math.min(120, Math.pow(2, currentSession.rateLimitCount)) * 1000;
    
    updateStatus(STATUS.WARNING, `Backing off for ${backoffTime/1000}s`);
    
    // Restart after backoff time
    setTimeout(() => {
      if (currentSession && currentSession.status === 'active') {
        startMonitoringAlarm();
        updateStatus(STATUS.ACTIVE, 'Monitoring resumed after backoff');
      }
    }, backoffTime);
  }
}

// Save session to storage
function saveSession(session) {
  chrome.storage.local.get([STORAGE_KEYS.SESSIONS], (result) => {
    let sessions = result[STORAGE_KEYS.SESSIONS] || [];
    
    // Find existing session index
    const index = sessions.findIndex(s => s.id === session.id);
    
    if (index !== -1) {
      // Update existing session
      sessions[index] = session;
    } else {
      // Add new session
      sessions.push(session);
    }
    
    // Sort by start time (newest first)
    sessions.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    
    chrome.storage.local.set({ [STORAGE_KEYS.SESSIONS]: sessions }, () => {
      log(`Session ${session.id} saved`);
    });
  });
}

// Load sessions into dropdown filter
function loadSessionsIntoFilter() {
  chrome.storage.local.get([STORAGE_KEYS.SESSIONS], (result) => {
    const sessions = result[STORAGE_KEYS.SESSIONS] || [];
    
    // Clear existing options except "All Sessions"
    while (domElements.sessionFilter.options.length > 1) {
      domElements.sessionFilter.remove(1);
    }
    
    // Add sessions to filter
    sessions.forEach(session => {
      addSessionToFilter(session);
    });
  });
}

// Add session to filter dropdown
function addSessionToFilter(session) {
  // Check if session already exists in filter
  for (let i = 0; i < domElements.sessionFilter.options.length; i++) {
    if (domElements.sessionFilter.options[i].value === session.id) {
      return;
    }
  }
  
  // Create option element
  const option = document.createElement('option');
  option.value = session.id;
  
  const date = new Date(session.startTime);
  option.textContent = `${formatDateTime(date)} (${session.status})`;
  
  // Add to dropdown
  domElements.sessionFilter.appendChild(option);
}

// Handle session filter change
function handleFilterChange() {
  loadHistoryData();
}

// Save response to storage
function saveResponse(response) {
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    let responses = result[STORAGE_KEYS.RESPONSES] || [];
    
    // Add new response
    responses.push(response);
    
    // Sort by timestamp (newest first)
    responses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    
    // Limit to 1000 responses
    if (responses.length > 1000) {
      responses = responses.slice(0, 1000);
    }
    
    chrome.storage.local.set({ [STORAGE_KEYS.RESPONSES]: responses }, () => {
      log(`Response ${response.id} saved`);
      
      // Refresh history if we're on that tab
      if (document.querySelector('#history-tab').getAttribute('aria-selected') === 'true') {
        loadHistoryData();
      }
    });
  });
}

// Show response in UI
function showResponseInUI(response) {
  if (!response) return;
  
  log('Showing response in UI', { responseId: response.id });
  
  // Display the response directly in the main UI
  if (domElements.responseContainer && domElements.responseText) {
    // Format the response text
    const formattedText = response.responseText || 'No response text';
    
    // Show the response container
    domElements.responseContainer.style.display = 'block';
    
    // Set the response text
    domElements.responseText.textContent = formattedText;
    
    // Scroll to make sure response is visible
    domElements.responseContainer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    log('Response container elements not found in DOM');
  }
  
  // For viewing history details, we'll still need a popup
  // But primary response viewing is now in the main UI
}

// Update storage usage display
function updateStorageUsage() {
  chrome.storage.local.getBytesInUse(null, (bytesInUse) => {
    const usageKB = Math.round(bytesInUse / 1024);
    const totalKB = 5120; // 5MB limit for local storage
    
    domElements.storageUsage.textContent = `${usageKB} KB / ${totalKB} KB`;
    
    // Warn if over 80% usage
    if (usageKB > totalKB * 0.8) {
      domElements.storageUsage.classList.add('text-danger');
      domElements.storageUsage.classList.remove('text-success');
    } else {
      domElements.storageUsage.classList.add('text-success');
      domElements.storageUsage.classList.remove('text-danger');
    }
  });
}

// Load history data from storage
function loadHistoryData() {
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    const responses = result[STORAGE_KEYS.RESPONSES] || [];
    const sessionId = domElements.sessionFilter.value;
    
    // Filter responses by session if needed
    const filteredResponses = sessionId === 'all' ? 
      responses : 
      responses.filter(r => r.sessionId === sessionId);
    
    // Clear existing rows
    domElements.historyTableBody.innerHTML = '';
    
    if (filteredResponses.length === 0) {
      // Show empty state
      domElements.historyTableBody.innerHTML = `
        <tr class="empty-state">
          <td colspan="5" class="text-center py-4">No history records found</td>
        </tr>
      `;
      return;
    }
    
    // Add responses to table
    filteredResponses.forEach(response => {
      const row = document.createElement('tr');
      
      // Time column
      const timeCell = document.createElement('td');
      const timestamp = new Date(response.timestamp);
      timeCell.textContent = formatDateTime(timestamp);
      row.appendChild(timeCell);
      
      // Image column
      const imageCell = document.createElement('td');
      const thumbnail = document.createElement('img');
      thumbnail.className = 'thumbnail';
      thumbnail.src = response.imageData;
      thumbnail.alt = 'Captured image';
      thumbnail.dataset.id = response.id;
      imageCell.appendChild(thumbnail);
      row.appendChild(imageCell);
      
      // Prompt column
      const promptCell = document.createElement('td');
      promptCell.textContent = response.prompt;
      row.appendChild(promptCell);
      
      // Response column
      const responseCell = document.createElement('td');
      responseCell.className = 'response-text';
      responseCell.textContent = response.responseText;
      responseCell.title = response.responseText;
      row.appendChild(responseCell);
      
      // Actions column
      const actionsCell = document.createElement('td');
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'btn-group btn-group-sm';
      
      const viewBtn = document.createElement('button');
      viewBtn.className = 'btn btn-outline-primary btn-sm';
      viewBtn.innerHTML = '<i class="bi bi-eye"></i>';
      viewBtn.title = 'View Details';
      viewBtn.dataset.id = response.id;
      
      const exportBtn = document.createElement('button');
      exportBtn.className = 'btn btn-outline-secondary btn-sm';
      exportBtn.innerHTML = '<i class="bi bi-download"></i>';
      exportBtn.title = 'Export';
      exportBtn.dataset.id = response.id;
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-outline-danger btn-sm';
      deleteBtn.innerHTML = '<i class="bi bi-trash"></i>';
      deleteBtn.title = 'Delete';
      deleteBtn.dataset.id = response.id;
      
      actionsDiv.appendChild(viewBtn);
      actionsDiv.appendChild(exportBtn);
      actionsDiv.appendChild(deleteBtn);
      actionsCell.appendChild(actionsDiv);
      row.appendChild(actionsCell);
      
      // Add event listeners
      thumbnail.addEventListener('click', () => handleViewResponse(response.id));
      viewBtn.addEventListener('click', () => handleViewResponse(response.id));
      exportBtn.addEventListener('click', () => handleExportResponse(response.id));
      deleteBtn.addEventListener('click', () => handleDeleteResponse(response.id));
      
      // Add row to table
      domElements.historyTableBody.appendChild(row);
    });
  });
}

// Handle view response action
function handleViewResponse(id) {
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    const responses = result[STORAGE_KEYS.RESPONSES] || [];
    const response = responses.find(r => r.id === id);
    
    if (!response) {
      log('Response not found', id);
      return;
    }
    
    // Create a modal to show the response
    const modal = document.createElement('div');
    modal.className = 'response-modal';
    modal.innerHTML = `
      <div class="response-modal-content">
        <div class="response-modal-header">
          <h5>Response Details</h5>
          <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="response-modal-body">
          <div class="response-detail">
            <strong>Time:</strong> ${formatDateTime(new Date(response.timestamp))}
          </div>
          <div class="response-detail">
            <strong>Model:</strong> ${response.model}
          </div>
          <div class="response-detail">
            <strong>Image Size:</strong> ${response.imageSize.width} x ${response.imageSize.height} 
            (${response.imageSize.total.toLocaleString()} pixels)
          </div>
          <div class="response-detail">
            <strong>Prompt:</strong>
            <div class="detail-text">${response.prompt}</div>
          </div>
          <div class="response-image">
            <img src="${response.imageData}" alt="Captured image">
          </div>
          <div class="response-detail">
            <strong>Response:</strong>
            <div class="detail-text">${response.responseText}</div>
          </div>
        </div>
        <div class="response-modal-footer">
          <button type="button" class="btn btn-sm btn-outline-secondary export-btn">Export JSON</button>
          <button type="button" class="btn btn-sm btn-outline-secondary copy-btn">Copy Response</button>
          <button type="button" class="btn btn-sm btn-outline-primary close-btn">Close</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Add event listeners to buttons
    modal.querySelector('.btn-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    modal.querySelector('.close-btn').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    modal.querySelector('.export-btn').addEventListener('click', () => {
      handleExportResponse(id);
    });
    
    modal.querySelector('.copy-btn').addEventListener('click', () => {
      navigator.clipboard.writeText(response.responseText)
        .then(() => {
          modal.querySelector('.copy-btn').textContent = 'Copied!';
          setTimeout(() => {
            modal.querySelector('.copy-btn').textContent = 'Copy Response';
          }, 2000);
        })
        .catch(err => log('Failed to copy text: ', err));
    });
  });
}

// Handle export response action
function handleExportResponse(id) {
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    const responses = result[STORAGE_KEYS.RESPONSES] || [];
    const response = responses.find(r => r.id === id);
    
    if (!response) {
      log('Response not found', id);
      return;
    }
    
    // Create exportable response object
    const exportData = {
      id: response.id,
      timestamp: response.timestamp,
      model: response.model,
      prompt: response.prompt,
      response: response.responseText,
      imageSize: response.imageSize,
      imageData: response.imageData
    };
    
    // Create download link
    const dataStr = JSON.stringify(exportData, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const timestamp = new Date(response.timestamp)
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .substring(0, 19);
    
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = `ai-watcher-response-${timestamp}.json`;
    
    // Append link and trigger download
    document.body.appendChild(downloadLink);
    downloadLink.click();
    
    // Clean up
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  });
}

// Handle delete response action
function handleDeleteResponse(id) {
  if (!confirm('Are you sure you want to delete this response?')) {
    return;
  }
  
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    let responses = result[STORAGE_KEYS.RESPONSES] || [];
    
    // Filter out the response to delete
    responses = responses.filter(r => r.id !== id);
    
    chrome.storage.local.set({ [STORAGE_KEYS.RESPONSES]: responses }, () => {
      log(`Response ${id} deleted`);
      
      // Refresh history
      loadHistoryData();
    });
  });
}

// Handle clear history action
function handleClearHistory() {
  const sessionId = domElements.sessionFilter.value;
  
  let confirmMessage = 'Are you sure you want to clear all history?';
  
  if (sessionId !== 'all') {
    confirmMessage = 'Are you sure you want to clear history for this session?';
  }
  
  if (!confirm(confirmMessage)) {
    return;
  }
  
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    let responses = result[STORAGE_KEYS.RESPONSES] || [];
    
    if (sessionId === 'all') {
      // Clear all responses
      responses = [];
    } else {
      // Filter out responses for the selected session
      responses = responses.filter(r => r.sessionId !== sessionId);
    }
    
    chrome.storage.local.set({ [STORAGE_KEYS.RESPONSES]: responses }, () => {
      log(`History cleared for session ${sessionId}`);
      
      // Refresh history
      loadHistoryData();
    });
  });
}

// Developer tab functions

// Handle test capture button
function handleTestCapture() {
  updateStatus(STATUS.PROCESSING, 'Testing capture...');
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'jpeg', quality: 70 }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          updateStatus(STATUS.ERROR, 'Capture test failed');
          log('Capture test failed', chrome.runtime.lastError);
          return;
        }
        
        // Show preview
        domElements.previewContainer.style.display = 'block';
        domElements.previewImage.src = dataUrl;
        
        // Store captured image
        capturedImage = {
          dataUrl,
          timestamp: new Date().toISOString()
        };
        
        updateStatus(STATUS.ACTIVE, 'Capture test successful');
        
        // Get image dimensions
        const img = new Image();
        img.onload = function() {
          pixelCounter = {
            width: this.width,
            height: this.height,
            total: this.width * this.height
          };
          
          // Update UI
          domElements.selectionInfo.style.display = 'block';
          domElements.dimensionsText.textContent = `${pixelCounter.width} x ${pixelCounter.height} px`;
          domElements.pixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
          
          // Calculate cost estimate
          const costPerPixel = COST_ESTIMATES[domElements.vlmModel.value] || 0.00001;
          const estimatedCost = (pixelCounter.total / 1000) * costPerPixel;
          domElements.costText.textContent = `$${estimatedCost.toFixed(6)}`;
          
          // Enable analyze button
          domElements.analyzeImage.disabled = false;
        };
        img.src = dataUrl;
      });
    }
  });
}

// Handle test API connection button
function handleTestAPIConnection() {
  updateStatus(STATUS.PROCESSING, 'Testing API connection...');
  
  // Get the API key from settings or default
  let apiKey = domElements.apiKey.value.trim();
  if (!apiKey) {
    // If no key entered, use the default
    apiKey = DEFAULT_SETTINGS.apiKey;
    log('Using default API key for test');
    // Show the default key in the input field
    domElements.apiKey.value = apiKey;
  }
  
  // Simple test payload
  const testPayload = {
    model: domElements.vlmModel.value,
    messages: [
      {
        role: "user",
        content: "Hello, testing API connection."
      }
    ],
    max_tokens: 10
  };
  
  // Send test request
  chrome.runtime.sendMessage({
    action: 'testApiConnection',
    payload: testPayload,
    apiKey: apiKey
  }, (response) => {
    if (response && response.success) {
      updateStatus(STATUS.ACTIVE, 'API connection successful');
      log('API test successful');
      
      // Show the model info in the response field for confirmation
      if (domElements.apiResponse) {
        domElements.apiResponse.value = JSON.stringify({
          success: true,
          model: response.data.model,
          message: "API connection successful!"
        }, null, 2);
      }
    } else {
      updateStatus(STATUS.ERROR, 'API connection failed');
      log('API test failed', response?.error);
      
      // Show the error in the response field
      if (domElements.apiResponse) {
        domElements.apiResponse.value = JSON.stringify({
          error: response?.error || 'Unknown error',
          message: "API connection failed!"
        }, null, 2);
      }
    }
  });
}

// Handle view logs button
function handleViewLogs() {
  chrome.storage.local.get([STORAGE_KEYS.DEBUG], (result) => {
    const logs = result[STORAGE_KEYS.DEBUG] || [];
    
    // Create a modal to show logs
    const modal = document.createElement('div');
    modal.className = 'response-modal wide-modal';
    modal.innerHTML = `
      <div class="response-modal-content">
        <div class="response-modal-header">
          <h5>Debug Logs</h5>
          <button type="button" class="btn-close" aria-label="Close"></button>
        </div>
        <div class="response-modal-body">
          <pre class="logs-container">${
            logs.length > 0 ? 
              logs.map(log => {
                const time = new Date(log.timestamp).toLocaleTimeString();
                return `[${time}] ${log.message} ${log.data ? JSON.stringify(log.data) : ''}`;
              }).join('\n') : 
              'No logs found'
          }</pre>
        </div>
        <div class="response-modal-footer">
          <button type="button" class="btn btn-sm btn-outline-secondary clear-btn">Clear Logs</button>
          <button type="button" class="btn btn-sm btn-outline-secondary copy-btn">Copy Logs</button>
          <button type="button" class="btn btn-sm btn-outline-primary close-btn">Close</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Add event listeners to buttons
    modal.querySelector('.btn-close').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    modal.querySelector('.close-btn').addEventListener('click', () => {
      document.body.removeChild(modal);
    });
    
    modal.querySelector('.clear-btn').addEventListener('click', () => {
      if (confirm('Are you sure you want to clear all logs?')) {
        chrome.storage.local.set({ [STORAGE_KEYS.DEBUG]: [] }, () => {
          document.body.removeChild(modal);
          log('Debug logs cleared');
        });
      }
    });
    
    modal.querySelector('.copy-btn').addEventListener('click', () => {
      const logsText = logs.map(log => {
        const time = new Date(log.timestamp).toLocaleTimeString();
        return `[${time}] ${log.message} ${log.data ? JSON.stringify(log.data) : ''}`;
      }).join('\n');
      
      navigator.clipboard.writeText(logsText)
        .then(() => {
          modal.querySelector('.copy-btn').textContent = 'Copied!';
          setTimeout(() => {
            modal.querySelector('.copy-btn').textContent = 'Copy Logs';
          }, 2000);
        })
        .catch(err => log('Failed to copy logs: ', err));
    });
  });
}

// Handle send API request button
function handleSendApiRequest() {
  const apiKey = domElements.apiKey.value.trim();
  
  if (!apiKey) {
    updateStatus(STATUS.ERROR, 'API key is required');
    return;
  }
  
  try {
    // Get the raw value from the textarea
    let payloadText = domElements.apiPayload.value.trim();
    
    // Check if it starts with a property name instead of "{" (common error)
    if (payloadText.indexOf('{') !== 0 && payloadText.match(/^\"[^\"]+\"\s*:/)) {
      // Wrap it in curly braces to make it a valid JSON object
      payloadText = `{${payloadText}}`;
    }
    
    const payload = JSON.parse(payloadText);
    const endpoint = domElements.apiEndpoint.value.trim();
    
    updateStatus(STATUS.PROCESSING, 'Sending API request...');
    
    // Send to background script to handle the API request
    chrome.runtime.sendMessage({
      action: 'customApiRequest',
      payload,
      apiKey,
      endpoint
    }, (response) => {
      if (response && response.success) {
        updateStatus(STATUS.ACTIVE, 'API request successful');
        domElements.apiResponse.value = JSON.stringify(response.data, null, 2);
      } else {
        updateStatus(STATUS.ERROR, 'API request failed');
        domElements.apiResponse.value = JSON.stringify(response.error, null, 2);
      }
    });
  } catch (error) {
    updateStatus(STATUS.ERROR, 'Invalid JSON payload');
    domElements.apiResponse.value = error.message;
  }
}

// Handle refresh storage button
function handleRefreshStorage() {
  const storageType = domElements.storageType.value;
  
  chrome.storage.local.get([STORAGE_KEYS[storageType.toUpperCase()]], (result) => {
    const data = result[STORAGE_KEYS[storageType.toUpperCase()]] || [];
    domElements.storageData.value = JSON.stringify(data, null, 2);
  });
  
  // Update storage usage
  updateStorageUsage();
}

// Handle export storage button
function handleExportStorage() {
  const storageType = domElements.storageType.value;
  
  chrome.storage.local.get([STORAGE_KEYS[storageType.toUpperCase()]], (result) => {
    const data = result[STORAGE_KEYS[storageType.toUpperCase()]] || [];
    
    // Create download link
    const dataStr = JSON.stringify(data, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    
    const timestamp = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .substring(0, 19);
    
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = `ai-watcher-${storageType}-${timestamp}.json`;
    
    // Append link and trigger download
    document.body.appendChild(downloadLink);
    downloadLink.click();
    
    // Clean up
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  });
}

// Handle clear storage button
function handleClearStorage() {
  const storageType = domElements.storageType.value;
  
  if (!confirm(`Are you sure you want to clear all ${storageType}?`)) {
    return;
  }
  
  chrome.storage.local.set({ [STORAGE_KEYS[storageType.toUpperCase()]]: [] }, () => {
    log(`${storageType} cleared`);
    
    // Refresh storage data
    handleRefreshStorage();
    
    // If clearing responses, refresh history
    if (storageType === 'responses') {
      loadHistoryData();
    }
    
    // If clearing sessions, refresh sessions dropdown
    if (storageType === 'sessions') {
      loadSessionsIntoFilter();
    }
  });
}

// Add CSS for modals
const modalStyles = `
.response-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 100;
}

.response-modal-content {
  background-color: white;
  border-radius: 4px;
  width: 80%;
  max-width: 350px;
  max-height: 90%;
  display: flex;
  flex-direction: column;
}

.wide-modal .response-modal-content {
  max-width: 500px;
}

.response-modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 15px;
  border-bottom: 1px solid #dee2e6;
}

.response-modal-header h5 {
  margin: 0;
  font-size: 16px;
}

.response-modal-body {
  padding: 15px;
  overflow-y: auto;
  flex: 1;
}

.response-modal-footer {
  padding: 10px 15px;
  border-top: 1px solid #dee2e6;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.response-detail {
  margin-bottom: 10px;
}

.detail-text {
  background-color: #f8f9fa;
  padding: 8px;
  border-radius: 4px;
  margin-top: 5px;
  white-space: pre-wrap;
}

.response-image {
  margin: 10px 0;
  max-height: 150px;
  overflow: hidden;
  text-align: center;
}

.response-image img {
  max-width: 100%;
  max-height: 150px;
}

.logs-container {
  background-color: #f8f9fa;
  padding: 10px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 12px;
  white-space: pre-wrap;
  max-height: 300px;
  overflow-y: auto;
}

.debug-mode .debug-info {
  display: block !important;
}
`;

// Add styles to document
const styleElement = document.createElement('style');
styleElement.textContent = modalStyles;
document.head.appendChild(styleElement);

// Save UI state to sync storage
function saveUIState() {
  const uiState = {
    promptText: domElements.promptText?.value || '',
    vlmModel: domElements.vlmModel?.value || DEFAULT_SETTINGS.vlmModel
  };
  
  chrome.storage.sync.set({ 'ui_state': uiState }, () => {
    log('UI state saved');
  });
}

// Load UI state from sync storage
function loadUIState() {
  chrome.storage.sync.get(['ui_state'], (result) => {
    const uiState = result.ui_state || {};
    
    // Restore prompt text
    if (uiState.promptText && domElements.promptText) {
      domElements.promptText.value = uiState.promptText;
    }
    
    // Restore model selection
    if (uiState.vlmModel && domElements.vlmModel) {
      domElements.vlmModel.value = uiState.vlmModel;
    }
    
    log('UI state loaded');
  });
}

// Check for any cached messages in the background
function checkCachedMessages() {
  chrome.runtime.sendMessage({ action: 'getCachedMessages' }, (response) => {
    if (response && response.success && response.cache) {
      log('Received cached messages from background:', response.cache);
      
      // Process each cached message
      Object.values(response.cache).forEach(cachedItem => {
        if (cachedItem && cachedItem.message) {
          const msg = cachedItem.message;
          log('Processing cached message:', msg.action);
          
          // Handle different message types
          if (msg.action === 'captureComplete' && msg.data) {
            log('Found cached capture - updating preview');
            handleCaptureComplete(msg.data, false);
          } else if (msg.action === 'analyzeComplete' && msg.data) {
            handleAnalyzeComplete(msg.data);
          } else if (msg.action === 'areaSelected' && msg.data) {
            handleAreaSelected(msg.data);
          }
        }
      });
    }
  });
}

// Handle test auto-capture and analyze button
function handleTestAutoCaptureAnalyze() {
  updateStatus(STATUS.PROCESSING, 'Starting auto-capture test...');
  
  // Set a flag that we're in auto test mode
  localStorage.setItem('autoTestMode', 'true');
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      updateStatus(STATUS.ERROR, 'Could not find active tab');
      return;
    }
    
    const activeTab = tabs[0];
    if (!activeTab.id) {
      updateStatus(STATUS.ERROR, 'Invalid tab ID');
      return;
    }
    
    // Define a fixed 100x100 area in the top-left corner
    const area = {
      left: 20, // Slight offset from corner for better visibility
      top: 20,
      width: 100,
      height: 100,
      devicePixelRatio: window.devicePixelRatio || 1
    };
    
    // Update UI to show the area dimensions
    pixelCounter = {
      width: area.width,
      height: area.height,
      total: area.width * area.height
    };
    
    if (domElements.selectionInfo) {
      domElements.selectionInfo.style.display = 'block';
    }
    
    if (domElements.dimensionsText) {
      domElements.dimensionsText.textContent = `${area.width} x ${area.height} px`;
    }
    
    if (domElements.pixelsText) {
      domElements.pixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
    }
    
    // Calculate cost estimate
    const costPerPixel = COST_ESTIMATES[domElements.vlmModel.value] || 0.00001;
    const estimatedCost = (pixelCounter.total / 1000) * costPerPixel;
    
    if (domElements.costText) {
      domElements.costText.textContent = `$${estimatedCost.toFixed(6)}`;
    }
    
    updateStatus(STATUS.PROCESSING, 'Auto-capturing 100x100 area...');
    log('Auto-test: Capturing 100x100 area from top-left', area);
    
    // Store the selected area for later use
    selectedArea = area;
    
    // Request to capture this area
    chrome.runtime.sendMessage({
      action: 'captureViewportArea',
      area: area,
      tabId: activeTab.id,
      windowId: activeTab.windowId
    }, response => {
      if (response && response.success) {
        updateStatus(STATUS.PROCESSING, 'Area capture requested. Waiting for result...');
        log('Auto-test: Capture request sent successfully');
        
        // Set a default prompt for testing
        if (domElements.promptText.value.trim() === '') {
          domElements.promptText.value = 'Describe what you see in this image.';
        }
      } else {
        updateStatus(STATUS.ERROR, 'Failed to capture area');
        log('Auto-test: Capture request failed', response?.error);
      }
    });
  });
} 