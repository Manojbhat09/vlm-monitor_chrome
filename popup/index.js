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
  vlmModel: 'moonshotai/kimi-vl-a3b-thinking:free',
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

// Add a periodic state update timer
let stateUpdateTimer = null;

// Model information loaded from JSON
let MODELS_DATA = [];
let COST_ESTIMATES = {}; // Will be populated from MODELS_DATA

// DOM elements
const domElements = {};

// Initialize when DOM content is loaded
document.addEventListener('DOMContentLoaded', () => {
  // Load model data first
  loadModelData().then(() => {
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
  }).catch(error => {
    console.error('Error loading model data:', error);
  });
});

// Load model data from JSON file
async function loadModelData() {
  try {
    const response = await fetch(chrome.runtime.getURL('data/models.json'));
    const data = await response.json();
    MODELS_DATA = data.models;
    
    // Initialize cost estimates from model data - NOW SUPPORTING BOTH PER-IMAGE AND PER-PIXEL COSTS
    MODELS_DATA.forEach(model => {
      // These costs in models.json are per million tokens, convert to per-token
      // For Claude 3 Haiku: 0.25 per M tokens = 0.00000025 per token
      const inputTokenCost = model.inputTokenCost / 1000000; 
      const outputTokenCost = model.outputTokenCost / 1000000;
      
      // Image cost in models.json depends on the pricing model
      // Either per-image or per-pixel
      const imageInputCost = model.imageInputCost;
      const isPixelBased = model.isPixelBased || false;
      
      COST_ESTIMATES[model.id] = {
        inputCost: inputTokenCost,
        outputCost: outputTokenCost,
        imageInputCost: imageInputCost,
        isPixelBased: isPixelBased
      };
      
      log(`Cost for ${model.id}:`, { 
        inputCost: inputTokenCost, 
        outputCost: outputTokenCost, 
        imageInputCost: imageInputCost,
        isPixelBased: isPixelBased
      });
    });
    
    log('Model data loaded', MODELS_DATA.length);
    log('Cost estimates initialized:', COST_ESTIMATES);
    return true;
  } catch (error) {
    log('Error loading model data', error);
    
    // Fallback to default cost estimates if model data can't be loaded
    COST_ESTIMATES = {
      'anthropic/claude-3-haiku': { inputCost: 0.00000025, outputCost: 0.00000075, imageInputCost: 0.0016, isPixelBased: false },
      'openai/gpt-4-vision': { inputCost: 0.00001, outputCost: 0.00003, imageInputCost: 0.0064, isPixelBased: false },
      'google/gemini-pro-vision': { inputCost: 0.00000125, outputCost: 0.000005, imageInputCost: 0.00516, isPixelBased: false },
      'test/pixel-based-model': { inputCost: 0.000001, outputCost: 0.000002, imageInputCost: 0.0000001, isPixelBased: true }
    };
    
    log('Using fallback cost estimates:', COST_ESTIMATES);
    return false;
  }
}

// Populate model dropdown from the loaded model data
function populateModelDropdown() {
  if (!domElements.vlmModel) {
    log('Error: VLM model element not found when populating dropdown');
    return;
  }
  
  if (!MODELS_DATA || !MODELS_DATA.length) {
    log('Error: No model data available when populating dropdown');
    return;
  }
  
  log('Populating model dropdown with', MODELS_DATA.length, 'models');
  
  // Clear existing options
  domElements.vlmModel.innerHTML = '';
  
  // Group models by free/paid status
  const freeModels = MODELS_DATA.filter(model => model.free);
  const paidModels = MODELS_DATA.filter(model => !model.free);
  
  log('Found', freeModels.length, 'free models and', paidModels.length, 'paid models');
  
  // Add free models first
  if (freeModels.length > 0) {
    const freeOptGroup = document.createElement('optgroup');
    freeOptGroup.label = 'Free Models';
    
    freeModels.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.name} (${model.provider}, Free)`;
      freeOptGroup.appendChild(option);
    });
    
    domElements.vlmModel.appendChild(freeOptGroup);
  }
  
  // Then add paid models
  if (paidModels.length > 0) {
    const paidOptGroup = document.createElement('optgroup');
    paidOptGroup.label = 'Paid Models';
    
    paidModels.forEach(model => {
      const option = document.createElement('option');
      option.value = model.id;
      option.textContent = `${model.name} (${model.provider}) — $${model.inputTokenCost}/M input, $${model.outputTokenCost}/M output`;
      option.title = model.description;
      paidOptGroup.appendChild(option);
    });
    
    domElements.vlmModel.appendChild(paidOptGroup);
  }
  
  // Try to set the previously saved model if available
  try {
    const settings = loadSettings();
    const savedModel = settings?.vlmModel || 'moonshotai/kimi-vl-a3b-thinking:free';
    log('Setting model from saved settings:', savedModel);
    
    if (domElements.vlmModel.querySelector(`option[value="${savedModel}"]`)) {
      domElements.vlmModel.value = savedModel;
      log('Successfully set saved model:', savedModel);
    } else {
      log('Saved model not found in options, using default');
      // Set default to first free model if available
      if (freeModels.length > 0) {
        domElements.vlmModel.value = freeModels[0].id;
      }
    }
  } catch (error) {
    log('Error setting saved model:', error);
  }
  
  // Manually trigger change event to update cost estimate
  log('Triggering change event on model dropdown');
  domElements.vlmModel.dispatchEvent(new Event('change'));
}

// Cache DOM elements for faster access
function cacheElements() {
  // Status
  domElements.statusIndicator = document.getElementById('statusIndicator');
  domElements.statusText = document.getElementById('statusText');
  
  // API Key Section (new)
  domElements.apiKeyStatus = document.getElementById('apiKeyStatus');
  domElements.captureApiKey = document.getElementById('captureApiKey');
  domElements.toggleCaptureApiKey = document.getElementById('toggleCaptureApiKey');
  domElements.saveApiKey = document.getElementById('saveApiKey');
  domElements.deleteApiKey = document.getElementById('deleteApiKey');

  // Capture tab
  domElements.captureViewport = document.getElementById('captureViewport');
  domElements.captureArea = document.getElementById('captureArea');
  domElements.testAutoCaptureAnalyze = document.getElementById('testAutoCaptureAnalyze');
  domElements.selectionInfo = document.getElementById('selectionInfo');
  domElements.dimensionsText = document.getElementById('dimensionsText');
  domElements.pixelsText = document.getElementById('pixelsText');
  domElements.costText = document.getElementById('costText');
  domElements.imageInputCostText = document.getElementById('imageInputCostText');
  domElements.outputCostText = document.getElementById('outputCostText');
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
  domElements.conversationMode = document.getElementById('conversationMode');
  domElements.monitorPrompt = document.getElementById('monitorPrompt');
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
  domElements.historyTabContent = document.getElementById('history');
  domElements.historyTable = document.getElementById('historyTable');
  domElements.historyTableBody = document.getElementById('historyTableBody');
  domElements.sessionFilter = document.getElementById('sessionFilter');
  domElements.refreshHistory = document.getElementById('refreshHistory');
  domElements.clearHistory = document.getElementById('clearHistory');
  domElements.exportAllHistory = document.getElementById('exportAllHistory');
  
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
  domElements.clearAllLocalStorage = document.getElementById('clearAllLocalStorage');
  
  // Add next capture countdown timer to the domElements
  domElements.nextCaptureTimer = document.getElementById('nextCaptureTimer');
  
  // Add the selectedAreaInfo element
  domElements.selectedAreaInfo = document.getElementById('selectedAreaInfo');
}

// Initialize UI based on settings
function initUI() {
  // Set up tabs
  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', () => {
      const tabId = button.dataset.tabId;
      switchTab(tabId);
    });
  });
  
  // Populate model dropdown from data
  populateModelDropdown();
  
  // Load any saved settings
  loadSettings();
  
  // Initialize UI elements
  updateStatus(STATUS.IDLE, 'Ready');
  
  // Update storage usage
  updateStorageUsage();
  
  // Populate history sessions
  loadSessionsIntoFilter();
  
  // Load history data
  loadHistoryData();
  
  // Check for any ongoing session
  checkOngoingSession();
  
  // Request current state from background script
  requestCurrentState();
}

// Check for any cached messages from the background script
function checkCachedMessages() {
  chrome.runtime.sendMessage({ action: 'getCachedMessages' }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error checking cached messages:', chrome.runtime.lastError);
      return;
    }
    
    if (response && response.success && response.cache) {
      log('Received cached messages from background script');
      
      // Process each cached message type
      Object.keys(response.cache).forEach(actionType => {
        const cachedItem = response.cache[actionType];
        
        // Skip if the message is too old (> 5 minutes)
        if (Date.now() - cachedItem.timestamp > 300000) {
          return;
        }
        
        const message = cachedItem.message;
        log('Processing cached message:', message);
        
        // Handle different message types
        switch (message.action) {
          case 'updateStatus':
            updateStatus(message.status, message.message);
            break;
          case 'areaSelected':
            handleAreaSelected(message.data);
            break;
          case 'captureComplete':
            handleCaptureComplete(message.data, message.analyze);
            break;
          case 'analyzeComplete':
            handleAnalyzeComplete(message.data);
            break;
          case 'sessionUpdate':
            if (message.session) {
              currentSession = message.session;
              updateSessionUI();
            }
            break;
          case 'rateLimitHit':
            handleRateLimit(message.data);
            break;
          case 'historyUpdated':
            loadHistoryData();
            break;
          case 'sessionListUpdated':
            loadSessionsIntoFilter();
            break;
          // Add more cases as needed
        }
      });
    }
  });
}

// Request current state from background script
function requestCurrentState() {
  chrome.runtime.sendMessage({ action: 'getCurrentState' }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error requesting current state:', chrome.runtime.lastError);
      return;
    }

    if (response && response.state) {
      log('Received current state from background script');
      
      // Important: Only update local session state if we don't have one
      // or if the background session is newer/different
      if (response.state.currentSession) {
        if (!currentSession || 
            currentSession.id !== response.state.currentSession.id ||
            currentSession.status !== response.state.currentSession.status) {
          // Update with the background's session
          currentSession = response.state.currentSession;
          updateSessionUI();
          
          // If session is active, ensure timer is running
          if (currentSession.status === 'active' && !sessionTimer) {
            startSessionTimer();
          } else if (currentSession.status !== 'active' && sessionTimer) {
            stopSessionTimer();
          }
        }
      }
      
      applyState(response.state);
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
        if (refreshResponse?.state?.capturedImage?.dataUrl) {
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
    
    // Update VLM model dropdown
    if (domElements.vlmModel) domElements.vlmModel.value = settings.vlmModel || DEFAULT_SETTINGS.vlmModel;
    
    // Update monitoring settings
    if (domElements.monitorInterval) domElements.monitorInterval.value = settings.monitorInterval || DEFAULT_SETTINGS.monitorInterval;
    if (domElements.enableNotifications) domElements.enableNotifications.checked = settings.enableNotifications !== false;
    if (domElements.autoBackoff) domElements.autoBackoff.checked = settings.autoBackoff !== false;
    if (domElements.conversationMode) domElements.conversationMode.checked = settings.conversationMode === true;
    if (domElements.monitorPrompt) domElements.monitorPrompt.value = settings.monitorPrompt || '';
    
    // Update debug settings
    if (domElements.enableDebugMode) domElements.enableDebugMode.checked = settings.debugMode === true;
    if (domElements.showPixelOverlay) domElements.showPixelOverlay.checked = settings.showPixelOverlay === true;
    
    // Update API key fields
    if (domElements.apiKey) domElements.apiKey.value = settings.apiKey || '';
    if (domElements.captureApiKey) {
      domElements.captureApiKey.value = settings.apiKey || '';
      updateApiKeyUI(settings.apiKey || '');
    }
    
    // Update prompt from storage
    if (domElements.promptText) {
      domElements.promptText.value = settings.lastPrompt || '';
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
    conversationMode: domElements.conversationMode?.checked || false,
    monitorPrompt: domElements.monitorPrompt?.value || '',
    debugMode: domElements.enableDebugMode.checked,
    showPixelOverlay: domElements.showPixelOverlay.checked,
    apiKey: apiKey,
    lastPrompt: domElements.promptText.value || ''
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
  // API Key Section listeners (new)
  domElements.toggleCaptureApiKey.addEventListener('click', () => {
    const apiKeyField = domElements.captureApiKey;
    apiKeyField.type = apiKeyField.type === 'password' ? 'text' : 'password';
    domElements.toggleCaptureApiKey.innerHTML = apiKeyField.type === 'password' ? 
      '<i class="bi bi-eye"></i>' : '<i class="bi bi-eye-slash"></i>';
  });

  domElements.saveApiKey.addEventListener('click', () => {
    const apiKey = domElements.captureApiKey.value.trim();
    if (!apiKey) {
      updateStatus(STATUS.WARNING, 'API key cannot be empty');
      return;
    }
    
    // Save to settings
    chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
      const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
      settings.apiKey = apiKey;
      chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings }, () => {
        updateApiKeyUI(apiKey);
        updateStatus(STATUS.ACTIVE, 'API key saved');
        
        // Also update the API key in the dev tab
        if (domElements.apiKey) {
          domElements.apiKey.value = apiKey;
        }
      });
    });
  });

  domElements.deleteApiKey.addEventListener('click', () => {
    if (confirm('Are you sure you want to delete your API key?')) {
      chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
        const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
        settings.apiKey = '';
        chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings }, () => {
          domElements.captureApiKey.value = '';
          updateApiKeyUI('');
          updateStatus(STATUS.WARNING, 'API key deleted');
          
          // Also update the API key in the dev tab
          if (domElements.apiKey) {
            domElements.apiKey.value = '';
          }
        });
      });
    }
  });

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
  domElements.conversationMode.addEventListener('change', saveSettings);
  domElements.monitorPrompt.addEventListener('input', saveSettings);
  domElements.startSession.addEventListener('click', handleStartSession);
  domElements.pauseSession.addEventListener('click', handlePauseSession);
  domElements.stopSession.addEventListener('click', handleStopSession);
  
  // History tab
  domElements.sessionFilter.addEventListener('change', handleFilterChange);
  domElements.refreshHistory.addEventListener('click', loadHistoryData);
  domElements.clearHistory.addEventListener('click', handleClearHistory);
  domElements.exportAllHistory.addEventListener('click', handleExportAllHistory);
  
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
  domElements.clearAllLocalStorage.addEventListener('click', handleClearAllLocalStorage);
  
  // Save settings when API key changes
  domElements.apiKey.addEventListener('change', saveSettings);
  
  // Add event listener for monitoring interval change
  domElements.monitorInterval.addEventListener('change', () => {
    const interval = parseInt(domElements.monitorInterval.value, 10);
    
    // Enforce minimum interval
    if (interval < 10) {
      domElements.monitorInterval.value = '10';
    }
    
    // If we have an active session, update its settings
    if (currentSession && currentSession.status === 'active') {
      log('Updating monitor interval to:', interval);
      
      chrome.runtime.sendMessage({
        action: 'updateSessionSettings',
        monitorInterval: Math.max(10, interval)
      });
    }
    
    // Save the interval to settings
    saveSettings();
  });
  
  // Add event listener for conversation mode toggle
  if (domElements.conversationMode) {
    domElements.conversationMode.addEventListener('change', () => {
      const enabled = domElements.conversationMode.checked;
      
      // If we have an active session, update its settings
      if (currentSession && currentSession.status === 'active') {
        log('Updating conversation mode to:', enabled);
        
        chrome.runtime.sendMessage({
          action: 'updateSessionSettings',
          conversationMode: enabled
        });
      }
      
      // Save the setting
      saveSettings();
    });
  }
  
  // Add event listener for monitoring prompt change
  domElements.monitorPrompt.addEventListener('change', () => {
    const prompt = domElements.monitorPrompt.value.trim();
    
    // If we have an active session, update its settings
    if (currentSession && currentSession.status === 'active') {
      log('Updating monitor prompt');
      
      chrome.runtime.sendMessage({
        action: 'updateSessionSettings',
        monitorPrompt: prompt
      });
    }
  });

  // VLM model change event
  if (domElements.vlmModel) {
    domElements.vlmModel.addEventListener('change', () => {
      // Save the setting
      saveSettings();
      
      // Log the model change
      log('VLM model changed to:', domElements.vlmModel.value);
      
      // Make sure the analyze button is enabled if there's a captured image
      if (capturedImage && domElements.analyzeImage) {
        domElements.analyzeImage.disabled = false;
      }
      
      // Recalculate costs if we have pixels data
      if (pixelCounter.total > 0) {
        // Call a function to recalculate and update costs
        updateCostEstimate();
      } else {
        // Update the default cost estimate
        updateDefaultCostEstimate();
      }
    });
  } else {
    log('Error: VLM model element not found when attaching event listener');
  }
}

// Handle messages from background
function handleMessages(message, sender, sendResponse) {
  log('Popup received message:', message.action);
  
  try {
    // Update the UI based on which message was received
    switch (message.action) {
      case 'updateStatus':
        if (message.status && message.message) {
          updateStatus(message.status, message.message);
        }
        sendResponse({ success: true });
        break;
        
      case 'areaSelected':
        handleAreaSelected(message.data);
        sendResponse({ success: true });
        break;
        
      case 'captureComplete':
        handleCaptureComplete(message.data, message.analyze !== false);
        sendResponse({ success: true });
        break;
        
      case 'analyzeComplete':
        handleAnalyzeComplete(message.data);
        sendResponse({ success: true });
        break;
        
      case 'sessionUpdate':
        log('Session update received');
        handleSessionUpdate(message.session);
        sendResponse({ success: true });
        break;
        
      case 'rateLimitHit':
        handleRateLimit(message.data);
        sendResponse({ success: true });
        break;
        
      case 'historyUpdated':
        loadHistoryData();
        sendResponse({ success: true });
        break;
        
      case 'sessionListUpdated':
        loadSessionsIntoFilter();
        sendResponse({ success: true });
        break;
        
      case 'debugLog':
        if (domElements.enableDebugMode?.checked) {
          console.log('[Debug]', message.data);
        }
        sendResponse({ success: true });
        break;
        
      default:
        sendResponse({ success: false, error: 'Unknown action in popup' });
        break;
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
  
  // Clear any existing image and UI
  if (domElements.previewImage) {
    domElements.previewImage.src = '';
  }
  
  // Show the preview container to indicate something is happening
  if (domElements.previewContainer) {
    domElements.previewContainer.style.display = 'block';
    // Optionally add a "loading" indication here
  }
  
  // Query for active tab to ensure we have the proper tab information
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      updateStatus(STATUS.ERROR, 'Could not find active tab for capture');
      return;
    }
    
    const activeTab = tabs[0];
    
    chrome.runtime.sendMessage({
      action: 'captureViewport',
      tabId: activeTab.id,
      windowId: activeTab.windowId
    }, (response) => {
      if (chrome.runtime.lastError) {
        updateStatus(STATUS.ERROR, 'Error communicating with extension: ' + chrome.runtime.lastError.message);
        log('Viewport capture communication error', chrome.runtime.lastError);
        return;
      }
      
      if (!response) {
        updateStatus(STATUS.ERROR, 'No response received from background');
        log('No response received from captureViewport message');
        return;
      }
      
      if (!response.success) {
        updateStatus(STATUS.ERROR, 'Failed to capture: ' + (response.error || 'Unknown error'));
        log('Viewport capture failed', response.error);
        return;
      }
      
      // If we got a response with data directly, use it
      if (response.data && response.data.dataUrl) {
        log('Viewport capture successful with direct data');
        handleCaptureComplete(response.data, false);
      } else {
        log('Viewport capture initiated, waiting for captureComplete message');
        // The capture was initiated but the data will come in a separate message
        // Just wait for the captureComplete message that should arrive shortly
      }
    });
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
  log('Area selected:', data);
  
  // Save the selected area to the global variable
  selectedArea = data;
  
  // If we have an active session, update it with the selected area
  if (currentSession && currentSession.status === 'active') {
    log('Updating selectedArea in active session');
    currentSession.selectedArea = data;
    saveSession(currentSession);
  }
  
  // Update UI
  updateStatus(STATUS.ACTIVE, 'Area selected');
  
  // Show selected area dimensions in UI if available
  if (domElements.selectedAreaInfo) {
    domElements.selectedAreaInfo.style.display = 'block';
    domElements.selectedAreaInfo.textContent = `Selected Area: ${data.w}×${data.h} at (${data.x},${data.y})`;
  }
}

// Handle analyze image button click
function handleAnalyzeImage() {
  const prompt = domElements.promptText ? domElements.promptText.value.trim() : '';
  
  if (!prompt) {
    updateStatus(STATUS.WARNING, 'Please enter a prompt first');
    return;
  }
  
  if (!capturedImage || !capturedImage.dataUrl) {
    updateStatus(STATUS.WARNING, 'No image captured yet');
    return;
  }
  
  // Disable the button while processing
  if (domElements.analyzeImage) {
    domElements.analyzeImage.disabled = true;
  }
  
  updateStatus(STATUS.PROCESSING, 'Analyzing image...');
  
  // Get the selected model
  const modelId = domElements.vlmModel ? domElements.vlmModel.value : DEFAULT_SETTINGS.vlmModel;
  
  // Create the payload object in the format expected by the background script
  const payload = {
    model: modelId,
    prompt: prompt,
    imageDataUrl: capturedImage.dataUrl
  };
  
  // Prepare metadata object
  const metadata = {
    prompt: prompt,
    timestamp: new Date().toISOString(),
    sessionId: currentSession?.id || null,
    isMonitoring: false,
    conversationMode: false,
    imageSize: pixelCounter.total > 0 ? pixelCounter : null
  };
  
  // Get API key from settings
  chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
    const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
    const apiKey = settings.apiKey?.trim();
    
    if (!apiKey) {
      updateStatus(STATUS.WARNING, 'API key not set. Please enter your API key.');
      // Re-enable the button
      if (domElements.analyzeImage) {
        domElements.analyzeImage.disabled = false;
      }
      return;
    }
    
    // Send message to background script
    try {
      log('Sending image for analysis', { prompt, modelId, payloadSize: capturedImage.dataUrl.length });
      
      // Clear previous response if any
      if (domElements.responseContainer) {
        domElements.responseContainer.style.display = 'none';
      }
      
      if (domElements.responseText) {
        domElements.responseText.innerHTML = '';
      }
      
      // Send message to background script with format it expects
      chrome.runtime.sendMessage({
        action: 'analyzeImage',
        payload: payload,
        apiKey: apiKey,
        metadata: metadata
      }, response => {
        if (chrome.runtime.lastError) {
          log('Error sending message:', chrome.runtime.lastError);
          updateStatus(STATUS.ERROR, 'Failed to send analysis request');
          
          // Re-enable the button on error
          if (domElements.analyzeImage) {
            domElements.analyzeImage.disabled = false;
          }
        }
      });
    } catch (error) {
      log('Error in handleAnalyzeImage:', error);
      updateStatus(STATUS.ERROR, 'Analysis failed');
      
      // Re-enable the button on error
      if (domElements.analyzeImage) {
        domElements.analyzeImage.disabled = false;
      }
    }
  });
}

// Handle capture complete from content or background script
function handleCaptureComplete(data, shouldAnalyze = true) {
  log('Capture complete', data);
  
  if (!data || !data.dataUrl) {
    updateStatus(STATUS.ERROR, 'Capture failed');
    return;
  }
  
  // Store captured image
  capturedImage = {
    dataUrl: data.dataUrl,
    timestamp: new Date().toISOString()
  };
  
  // Update status
  updateStatus(STATUS.ACTIVE, 'Image captured');
  
  // Show preview
  domElements.previewContainer.style.display = 'block';
  domElements.previewImage.src = data.dataUrl;
  
  // Enable analyze button
  domElements.analyzeImage.disabled = false;
  
  // Update pixel information
  const img = new Image();
  img.onload = function() {
    // Update pixel counter
    pixelCounter = {
      width: this.width,
      height: this.height,
      total: this.width * this.height
    };
    
    log('Pixel information updated:', pixelCounter);
    
    // Update selection info
    if (domElements.selectionInfo) {
      domElements.selectionInfo.style.display = 'block';
      domElements.dimensionsText.textContent = `${pixelCounter.width} x ${pixelCounter.height} px`;
      domElements.pixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
    }
    
    // Always update cost estimate when image is loaded
    updateCostEstimate();
    
    // Analyze image if requested
    if (shouldAnalyze) {
      handleAnalyzeImage();
    }
  };
  img.src = data.dataUrl;
}

// Handle analyze complete from background script
function handleAnalyzeComplete(data) {
  let response = data.response;
  let error = data.error;
  
  log('Analyze complete received', { response, error });
  
  if (error) {
    updateStatus(STATUS.ERROR, error.message || 'Analysis failed');
    return;
  }
  
  // Show response in UI (don't save again - it's already saved in background)
  if (response) {
    // Response is already saved in background script, so just show it
    showResponseInUI(response);
    
    // Keep the analyze button enabled if we have a captured image
    if (domElements.analyzeImage && capturedImage) {
      domElements.analyzeImage.disabled = false;
    }
    
    // Add to conversation history if in conversation mode
    if (currentSession && currentSession.settings?.conversationMode) {
      // Add to conversation history
      if (!currentSession.conversationHistory) {
        currentSession.conversationHistory = [];
      }
      
      // Push prompt and response to history
      currentSession.conversationHistory.push(`User: ${response.prompt}`);
      currentSession.conversationHistory.push(`AI: ${response.responseText}`);
      
      // Limit history to last 10 exchanges
      if (currentSession.conversationHistory.length > 20) {
        currentSession.conversationHistory = currentSession.conversationHistory.slice(currentSession.conversationHistory.length - 20);
      }
      
      // Save updated session
      saveSession(currentSession);
    }
    
    // IMPORTANT: Set the status to active rather than idle if we're in monitor mode
    if (currentSession && currentSession.status === 'active') {
      updateStatus(STATUS.ACTIVE, 'Analysis complete - monitoring continuing');
      
      // Make sure we don't lose active state in the UI
      updateSessionUI();
      
      // Start the countdown timer for next capture
      startCaptureCountdown();
    } else {
      updateStatus(STATUS.IDLE, 'Analysis complete');
    }
    
    // Refresh history if we're on that tab
    if (document.querySelector('#history-tab').getAttribute('aria-selected') === 'true') {
      loadHistoryData();
    }
  }
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
  log('Checking for ongoing session...');
  
  chrome.runtime.sendMessage({ action: 'getCurrentState' }, response => {
    if (chrome.runtime.lastError || !response?.success) {
      log('Error checking for ongoing session:', chrome.runtime.lastError || response?.error);
      return;
    }
    
    const state = response.state;
    
    if (state.currentSession) {
      log('Ongoing session found:', state.currentSession.id);
      
      // Store the session data
      currentSession = state.currentSession;
      
      // Restore the prompt from the session if available
      if (currentSession.settings?.monitorPrompt) {
        domElements.monitorPrompt.value = currentSession.settings.monitorPrompt;
      }
      
      // Restore conversation mode setting if available
      if (domElements.conversationMode && currentSession.settings?.conversationMode !== undefined) {
        domElements.conversationMode.checked = currentSession.settings.conversationMode;
      }
      
      // Update UI
      updateSessionUI();
      
      // Start session timer if active
      if (currentSession.status === 'active') {
        startSessionTimer();
        
        // Start countdown for next capture if scheduled
        if (currentSession.nextScheduledCapture) {
          const nextCaptureTime = new Date(currentSession.nextScheduledCapture).getTime();
          startCaptureCountdown(nextCaptureTime);
        }
      }
    } else {
      log('No ongoing session found');
      currentSession = null;
      updateSessionUI();
    }
  });
}

// Function to stop the capture countdown timer
function stopCaptureCountdown() {
  if (window.captureCountdownTimer) {
    clearInterval(window.captureCountdownTimer);
    window.captureCountdownTimer = null;
    if (domElements.nextCaptureTimer) {
      domElements.nextCaptureTimer.textContent = '--';
      domElements.nextCaptureTimer.classList.remove('bg-warning');
      domElements.nextCaptureTimer.classList.add('bg-primary');
    }
  }
}

// Update session UI based on current session
function updateSessionUI() {
  if (!currentSession) {
    // No active session
    domElements.sessionStatus.textContent = 'Inactive';
    domElements.sessionStatus.className = 'badge bg-secondary';
    
    domElements.startSession.disabled = false;
    domElements.startSession.textContent = 'Start Session'; // Reset button text
    domElements.pauseSession.disabled = true;
    domElements.stopSession.disabled = true;
    
    domElements.sessionStartTime.textContent = '--';
    domElements.sessionDuration.textContent = '00:00:00';
    domElements.captureCount.textContent = '0';
    domElements.lastCaptureTime.textContent = '--';
    domElements.nextCaptureTimer.textContent = '--';
    domElements.apiCallCount.textContent = '0';
    domElements.rateLimitCount.textContent = '0';
    
    stopCaptureCountdown(); // Make sure countdown stops
    return;
  }
  
  // Add another safety check inside the main logic
  if (!currentSession) {
    log("Error: currentSession became null unexpectedly within updateSessionUI's else block.");
    // Schedule reset
    setTimeout(updateSessionUI, 0);
    return; // Exit to prevent further errors
  }
  
  // Update status based on session state
  if (currentSession.status === 'active') {
    domElements.sessionStatus.textContent = 'Active';
    domElements.sessionStatus.className = 'badge bg-success';
    
    domElements.startSession.disabled = true;
    domElements.pauseSession.disabled = false;
    domElements.stopSession.disabled = false;
  } else if (currentSession.status === 'paused') {
    domElements.sessionStatus.textContent = 'Paused';
    domElements.sessionStatus.className = 'badge bg-warning text-dark';
    
    domElements.startSession.disabled = false; // Enable to allow resume
    domElements.startSession.textContent = 'Resume'; // Change text for resume
    domElements.pauseSession.disabled = true;
    domElements.stopSession.disabled = false;
  } else {
    domElements.sessionStatus.textContent = 'Completed';
    domElements.sessionStatus.className = 'badge bg-secondary'; // Changed from info to secondary
    
    domElements.startSession.disabled = false;
    domElements.startSession.textContent = 'Start Session'; // Reset text
    domElements.pauseSession.disabled = true;
    domElements.stopSession.disabled = true;
  }
  
  // Update session stats with safety checks
  domElements.sessionStartTime.textContent = currentSession.startTime ? 
    formatDateTime(new Date(currentSession.startTime)) : '--';
  domElements.captureCount.textContent = currentSession.captureCount || '0';
  domElements.apiCallCount.textContent = currentSession.apiCallCount || '0';
  domElements.rateLimitCount.textContent = currentSession.rateLimitCount || '0';
  
  // Update last capture time if available
  if (currentSession.lastCaptureTime) {
    domElements.lastCaptureTime.textContent = formatTime(new Date(currentSession.lastCaptureTime));
  } else {
    domElements.lastCaptureTime.textContent = '--';
  }
  
  // If session is active and has a next scheduled capture, show countdown
  if (currentSession.status === 'active' && currentSession.nextScheduledCapture) {
    const nextCaptureTime = new Date(currentSession.nextScheduledCapture).getTime();
    startCaptureCountdown(nextCaptureTime);
  } else {
    // No next capture, show placeholder
    stopCaptureCountdown();
  }
  
  // Update selected area info if present
  if (currentSession.selectedArea) {
    const area = currentSession.selectedArea;
    domElements.selectedAreaInfo.textContent = `Selected Area: ${area.width}×${area.height} at (${area.left},${area.top})`;
    domElements.selectedAreaInfo.style.display = 'block';
  } else {
    domElements.selectedAreaInfo.textContent = 'Selected Area: Full viewport';
    domElements.selectedAreaInfo.style.display = 'block';
  }
}

// Start a new monitoring session
function handleStartSession() {
  // Check for paused state FIRST
  if (currentSession && currentSession.status === 'paused') {
    handleResumeSession(); // Call resume function
    return; // Don't proceed to start new session
  }

  // If already active, do nothing
  if (currentSession && currentSession.status === 'active') {
    updateStatus('warning', "Session already active.");
    return;
  }
  
  log('Starting new monitoring session');
  const prompt = domElements.monitorPrompt.value.trim();
  
  if (!prompt) {
    alert('Please enter a monitoring prompt before starting the session.');
    return;
  }
  
  // Get conversation mode setting
  const conversationMode = domElements.conversationMode.checked;
  
  // Disable buttons during processing
  domElements.startSession.disabled = true;
  domElements.pauseSession.disabled = true;
  domElements.stopSession.disabled = true;
  
  // Update status
  updateStatus('processing', 'Starting session...');
  
  // Get the active tab and window information
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      updateStatus('error', 'Cannot start session: No active tab found.');
      domElements.startSession.disabled = false;
      return;
    }
    
    const activeTab = tabs[0];
    const initialTabId = activeTab.id;
    const initialWindowId = activeTab.windowId;
    
    // First check if we have a selected area from the state
    chrome.runtime.sendMessage({
      action: 'startSession',
      selectedArea: selectedArea,
      prompt: prompt,
      conversationMode: conversationMode,
      tabId: initialTabId,
      windowId: initialWindowId
    }, response => {
      if (chrome.runtime.lastError) {
        log('Error starting session:', chrome.runtime.lastError);
        domElements.startSession.disabled = false;
        updateStatus('error', 'Failed to start session: ' + chrome.runtime.lastError.message);
        return;
      }
      
      if (!response || !response.success) {
        log('Failed to start session:', response?.error || 'Unknown error');
        domElements.startSession.disabled = false;
        updateStatus('error', 'Failed to start session');
        return;
      }
      
      // Check if response.session is null or undefined
      if (!response.session) {
        log('Error: Received null session from background');
        domElements.startSession.disabled = false;
        updateStatus('error', 'Failed to start session: Session data missing');
        return;
      }
      
      log('Session started successfully');
      
      // Store the session data
      currentSession = response.session;
      
      // Make sure tab and window IDs are captured in the session
      if (currentSession && !currentSession.tabId) {
        currentSession.tabId = initialTabId;
        log('Added tabId to session:', initialTabId);
      }
      
      if (currentSession && !currentSession.windowId) {
        currentSession.windowId = initialWindowId;
        log('Added windowId to session:', initialWindowId);
      }
      
      // Save the session with updated tab/window IDs
      if (currentSession) {
        saveSession(currentSession);
      }
      
      // Update UI
      updateSessionUI();
      
      // Reset session stats display
      if (currentSession && currentSession.startTime) {
        domElements.sessionStartTime.textContent = formatDateTime(new Date(currentSession.startTime));
      } else {
        domElements.sessionStartTime.textContent = '--';
      }
      
      domElements.sessionDuration.textContent = '00:00:00';
      domElements.captureCount.textContent = currentSession?.captureCount || '0';
      domElements.lastCaptureTime.textContent = '--';
      domElements.nextCaptureTimer.textContent = 'Starting...';
      domElements.apiCallCount.textContent = currentSession?.apiCallCount || '0';
      domElements.rateLimitCount.textContent = currentSession?.rateLimitCount || '0';
      
      // Start session timer
      startSessionTimer();
    });
  });
}

// Add function to handle resuming a paused session
function handleResumeSession() {
  if (!currentSession || currentSession.status !== 'paused') {
    log('No paused session to resume.');
    return;
  }
  
  log('Resuming session...');
  updateStatus('processing', 'Resuming session...');
  
  // Disable buttons during processing
  domElements.startSession.disabled = true;
  domElements.pauseSession.disabled = true;
  domElements.stopSession.disabled = true;

  // Send message to background to resume
  chrome.runtime.sendMessage({ 
    action: 'resumeSession' 
  }, response => {
    if (chrome.runtime.lastError || !response?.success) {
      updateStatus('error', "Failed to resume session in background.");
      log("Error resuming session", chrome.runtime.lastError || response?.error);
      updateSessionUI(); // Reset UI state
      return;
    }
    
    log("Background confirmed session resume", response.session);
    // Background will send 'sessionUpdate', but update the session data here for immediate feedback
    currentSession = response.session;
    updateSessionUI();
    startSessionTimer();
    updateStatus('active', 'Session resumed');
  });
}

// Pause current monitoring session
function handlePauseSession() {
  if (!currentSession || currentSession.status !== 'active') {
    log('No active session to pause');
    return;
  }
  
  log('Pausing session');
  
  // Disable buttons during processing
  domElements.startSession.disabled = true;
  domElements.pauseSession.disabled = true;
  domElements.stopSession.disabled = true;
  
  // Update status
  updateStatus('processing', 'Pausing session...');
  
  chrome.runtime.sendMessage({
    action: 'pauseSession'
  }, response => {
    if (chrome.runtime.lastError || !response?.success) {
      log('Error pausing session:', chrome.runtime.lastError || response?.error);
      updateSessionUI(); // Reset UI
      updateStatus('error', 'Failed to pause session');
      return;
    }
    
    log('Session paused successfully');
    
    // Update session data
    currentSession = response.session;
    
    // Update UI
    updateSessionUI();
    
    // Stop the session timer
    stopSessionTimer();
    
    // Clear countdown timer
    if (window.captureCountdownTimer) {
      clearInterval(window.captureCountdownTimer);
      window.captureCountdownTimer = null;
      domElements.nextCaptureTimer.textContent = '--';
    }
    
    updateStatus('idle', 'Session paused');
  });
}

// Stop current monitoring session
function handleStopSession() {
  if (!currentSession) {
    log('No session to stop');
    return;
  }
  
  log('Stopping session');
  
  // Disable buttons during processing
  domElements.startSession.disabled = true;
  domElements.pauseSession.disabled = true;
  domElements.stopSession.disabled = true;
  
  // Update status
  updateStatus('processing', 'Stopping session...');
  
  chrome.runtime.sendMessage({
    action: 'stopSession'
  }, response => {
    if (chrome.runtime.lastError || !response?.success) {
      log('Error stopping session:', chrome.runtime.lastError || response?.error);
      updateSessionUI(); // Reset UI
      updateStatus('error', 'Failed to stop session');
      return;
    }
    
    log('Session stopped successfully');
    
    // Clear session data
    currentSession = null;
    
    // Update UI for no session
    updateSessionUI();
    
    // Stop timers
    stopSessionTimer();
    if (window.captureCountdownTimer) {
      clearInterval(window.captureCountdownTimer);
      window.captureCountdownTimer = null;
      domElements.nextCaptureTimer.textContent = '--';
    }
    
    updateStatus('idle', 'Session stopped');
  });
}

// Start the session timer
function startSessionTimer() {
  if (sessionTimer) {
    clearInterval(sessionTimer);
  }
  
  // Update duration immediately once
  if (currentSession && currentSession.status === 'active') {
    const duration = getSessionDuration();
    domElements.sessionDuration.textContent = formatDuration(duration);
  }
  
  sessionTimer = setInterval(() => {
    if (currentSession && currentSession.status === 'active') {
      const duration = getSessionDuration();
      domElements.sessionDuration.textContent = formatDuration(duration);
      
      // Save the current duration to the session periodically
      if (duration % 10 === 0) { // Every 10 seconds
        currentSession.duration = duration;
        saveSession(currentSession);
      }
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
  // Instead of directly checking the alarm, ask the background script about the session state
  chrome.runtime.sendMessage({ action: 'getCurrentState' }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error checking monitoring state:', chrome.runtime.lastError);
      return;
    }
    
    // If we have an active session locally but the background doesn't, update it
    if (currentSession && currentSession.status === 'active' && 
        (!response.state.currentSession || response.state.currentSession.status !== 'active')) {
      log('Session state mismatch - requesting background to start monitoring');
      startMonitoringAlarm();
    }
  });
}

// Start the monitoring alarm
function startMonitoringAlarm() {
  const settings = saveSettings();
  const intervalSeconds = Math.max(10, settings.monitorInterval);
  
  // Send message to background script to create/update the alarm
  chrome.runtime.sendMessage({
    action: 'updateSessionSettings',
    settings: {
      monitorInterval: intervalSeconds
    }
  }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error updating monitoring interval:', chrome.runtime.lastError);
      return;
    }
    log(`Monitoring alarm requested with interval: ${intervalSeconds} seconds`);
  });
}

// Update the monitoring alarm interval
function updateMonitoringAlarm() {
  startMonitoringAlarm();
}

// Stop the monitoring alarm
function stopMonitoringAlarm() {
  // No need to remove listener since we're not adding one anymore
  chrome.runtime.sendMessage({
    action: 'stopSession'
  }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error stopping monitoring alarm:', chrome.runtime.lastError);
      return;
    }
    log('Monitoring alarm stop requested');
  });
}

// Function kept for compatibility but no longer needs to register a listener
function handleAlarm(alarm) {
  // This function is no longer used to handle alarms directly
  // All alarm handling is done in the background script
  log('Local alarm handler called but ignored - using background handler');
}

// Capture the screen for monitoring
function captureForMonitoring() {
  log('Automatic capture triggered by monitoring alarm');
  
  if (!currentSession) {
    log('No active session found, aborting monitoring capture');
    return;
  }
  
  // Get the monitoring prompt
  const settings = saveSettings();
  const monitorPrompt = settings.monitorPrompt || 'Analyze this image and describe what you see.';
  
  // Update session stats
  currentSession.captureCount = (currentSession.captureCount || 0) + 1;
  currentSession.lastCaptureTime = new Date().toISOString();
  saveSession(currentSession);
  
  // Update UI
  updateSessionUI();
  
  // Ensure the selected area is saved in the session
  if (selectedArea && !currentSession.selectedArea) {
    currentSession.selectedArea = selectedArea;
    saveSession(currentSession);
  }
  
  // If we have a selected area, use that, otherwise capture the viewport
  if (selectedArea || currentSession.selectedArea) {
    const areaToCapture = selectedArea || currentSession.selectedArea;
    log('Monitor: Capturing selected area', areaToCapture);
    
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        // Send message to capture area
        chrome.runtime.sendMessage({
          action: 'captureViewportArea',
          area: areaToCapture,
          tabId: tabs[0].id,
          windowId: tabs[0].windowId,
          autoAnalyze: true, // Signal we want automatic analysis
          monitorSession: {
            sessionId: currentSession.id,
            prompt: monitorPrompt,
            conversationMode: settings.conversationMode || false
          }
        }, (response) => {
          if (chrome.runtime.lastError || !response?.success) {
            log('Error in monitor capture', chrome.runtime.lastError);
            return;
          }
          log('Monitor capture successfully initiated');
        });
      } else {
        log('No active tab found for monitor capture');
      }
    });
  } else {
    log('Monitor: Capturing viewport (no area selected)');
    chrome.runtime.sendMessage({
      action: 'captureViewport',
      autoAnalyze: true, // Signal we want automatic analysis
      monitorSession: {
        sessionId: currentSession.id,
        prompt: monitorPrompt,
        conversationMode: settings.conversationMode || false
      }
    }, (response) => {
      if (chrome.runtime.lastError || !response?.success) {
        log('Error in monitor viewport capture', chrome.runtime.lastError);
        return;
      }
      log('Monitor viewport capture successfully initiated');
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
  log('Showing response in UI', { id: response.id });
  
  if (domElements.responseContainer) {
    domElements.responseContainer.style.display = 'block';
  }
  
  if (domElements.responseText) {
    domElements.responseText.innerHTML = response.responseText.replace(/\n/g, '<br>');
  }
  
  // Keep the analyze button enabled if there's a captured image available
  if (capturedImage && domElements.analyzeImage) {
    domElements.analyzeImage.disabled = false;
  }
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
      actionsDiv.className = 'btn-group btn-group-sm d-flex justify-content-between';
      
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
      
      // Add delete session button
      const deleteSessionBtn = document.createElement('button');
      deleteSessionBtn.className = 'btn btn-outline-danger btn-sm delete-session-btn';
      deleteSessionBtn.innerHTML = '<i class="bi bi-trash-fill"></i>';
      deleteSessionBtn.title = 'Delete Session';
      deleteSessionBtn.dataset.sessionId = response.sessionId;
      
      actionsDiv.appendChild(viewBtn);
      actionsDiv.appendChild(exportBtn);
      actionsDiv.appendChild(deleteBtn);
      actionsDiv.appendChild(deleteSessionBtn);
      actionsCell.appendChild(actionsDiv);
      row.appendChild(actionsCell);
      
      // Add event listeners
      thumbnail.addEventListener('click', () => handleViewResponse(response.id));
      viewBtn.addEventListener('click', () => handleViewResponse(response.id));
      exportBtn.addEventListener('click', () => handleExportResponse(response.id));
      deleteBtn.addEventListener('click', () => handleDeleteResponse(response.id));
      deleteSessionBtn.addEventListener('click', () => handleDeleteSession(response.sessionId));
      
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

// Handle delete session action
function handleDeleteSession(sessionId) {
  if (!confirm('Are you sure you want to delete ALL data for this session?')) {
    return;
  }
  
  // Get both responses and sessions from storage
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES, STORAGE_KEYS.SESSIONS], (result) => {
    let responses = result[STORAGE_KEYS.RESPONSES] || [];
    let sessions = result[STORAGE_KEYS.SESSIONS] || [];
    
    // Filter out responses for this session
    responses = responses.filter(r => r.sessionId !== sessionId);
    
    // Filter out the session itself
    sessions = sessions.filter(s => s.id !== sessionId);
    
    // Save the filtered data back to storage
    chrome.storage.local.set({
      [STORAGE_KEYS.RESPONSES]: responses,
      [STORAGE_KEYS.SESSIONS]: sessions
    }, () => {
      log(`Session ${sessionId} and all its data deleted`);
      
      // Refresh history and session filter
      loadHistoryData();
      loadSessionsIntoFilter();
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
          
          // Calculate and update cost estimate
          updateCostEstimate();
          
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
    
    // Parse the JSON payload
    const payload = JSON.parse(payloadText);
    
    // Disable UI
    domElements.sendApiRequest.disabled = true;
    updateStatus(STATUS.PROCESSING, 'Sending API request...');
    
    // Send message to background script
    chrome.runtime.sendMessage({
      action: 'customApiRequest',
      endpoint: domElements.apiEndpoint.value,
      payload,
      apiKey
    }, (response) => {
      // Re-enable UI
      domElements.sendApiRequest.disabled = false;
      
      if (chrome.runtime.lastError || !response.success) {
        updateStatus(STATUS.ERROR, 'API request failed');
        domElements.apiResponse.value = JSON.stringify(response.error || chrome.runtime.lastError, null, 2);
        return;
      }
      
      updateStatus(STATUS.ACTIVE, 'API request successful');
      domElements.apiResponse.value = JSON.stringify(response.data, null, 2);
    });
  } catch (error) {
    updateStatus(STATUS.ERROR, 'Invalid JSON payload');
    domElements.apiResponse.value = error.toString();
  }
}

// Handle refresh storage button
function handleRefreshStorage() {
  // Implementation of handleRefreshStorage function
}

// Handle export storage button
function handleExportStorage() {
  // Implementation of handleExportStorage function
}

// Handle clear storage button
function handleClearStorage() {
  // Implementation of handleClearStorage function
}

// Handle clear all local storage button
function handleClearAllLocalStorage() {
  if (!confirm('⚠️ WARNING: This will delete ALL extension data! ⚠️\n\nThis is irreversible and will clear ALL settings, sessions, responses, and images.\n\nAre you absolutely sure?')) {
    return;
  }
  
  // Double-check with another confirmation
  if (!confirm('FINAL WARNING: All data will be permanently deleted.\n\nClick OK to proceed with deletion.')) {
    return;
  }
  
  // Clear all local storage
  chrome.storage.local.clear(() => {
    if (chrome.runtime.lastError) {
      log('Error clearing storage:', chrome.runtime.lastError);
      return;
    }
    
    log('All local storage cleared');
    
    // Reset UI state
    loadHistoryData();
    loadSessionsIntoFilter();
    updateStorageUsage();
    loadSettings();
    
    // Clear any active sessions
    currentSession = null;
    updateSessionUI();
    
    // Reset the UI state
    localStorage.removeItem('autoTestMode');
    
    // Show confirmation
    alert('All local storage has been cleared successfully.');
  });
}

// Load UI state from storage
function loadUIState() {
  chrome.storage.local.get(['ui_state'], (result) => {
    const uiState = result.ui_state || {};
    
    // Restore active tab if saved
    if (uiState.activeTab) {
      // Find and click the tab button to switch to it
      const tabButton = document.querySelector(`.tab-button[data-tab-id="${uiState.activeTab}"]`);
      if (tabButton) {
        tabButton.click();
      }
    }
    
    // Restore prompt text if saved
    if (uiState.promptText && domElements.promptText) {
      domElements.promptText.value = uiState.promptText;
    }
    
    // Any other UI state can be restored here
    log('UI state loaded');
  });
}

// Save UI state to storage
function saveUIState() {
  const uiState = {
    activeTab: document.querySelector('.tab-button.active')?.dataset.tabId,
    promptText: domElements.promptText?.value || ''
    // Add other UI state elements as needed
  };
  
  chrome.storage.local.set({ 'ui_state': uiState }, () => {
    if (domElements.enableDebugMode?.checked) {
      log('UI state saved');
    }
  });
}

// Update API key UI elements based on key validity
function updateApiKeyUI(apiKey) {
  if (!domElements.apiKeyStatus || !domElements.captureApiKey) {
    return;
  }
  
  if (apiKey && apiKey.trim()) {
    // Valid API key
    domElements.apiKeyStatus.textContent = 'API Key: Set';
    domElements.apiKeyStatus.className = 'badge bg-success';
    domElements.captureApiKey.classList.remove('is-invalid');
    domElements.captureApiKey.classList.add('is-valid');
  } else {
    // Invalid or missing API key
    domElements.apiKeyStatus.textContent = 'API Key: Not Set';
    domElements.apiKeyStatus.className = 'badge bg-warning';
    domElements.captureApiKey.classList.remove('is-valid');
    domElements.captureApiKey.classList.add('is-invalid');
  }
}

// Switch between tabs
function switchTab(tabId) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.style.display = 'none';
  });
  
  // Deactivate all tab buttons
  document.querySelectorAll('.tab-button').forEach(button => {
    button.classList.remove('active');
  });
  
  // Show selected tab
  const selectedTab = document.getElementById(tabId);
  if (selectedTab) {
    selectedTab.style.display = 'block';
  }
  
  // Activate selected tab button
  const selectedButton = document.querySelector(`.tab-button[data-tab-id="${tabId}"]`);
  if (selectedButton) {
    selectedButton.classList.add('active');
  }
  
  // Save UI state
  saveUIState();
}

// Handle test auto capture and analyze button click
function handleTestAutoCaptureAnalyze() {
  updateStatus(STATUS.PROCESSING, 'Auto-capturing and analyzing...');
  
  // Set a flag to indicate we're in auto test mode
  localStorage.setItem('autoTestMode', 'true');
  
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      updateStatus(STATUS.ERROR, 'Could not find active tab');
      return;
    }
    
    const activeTab = tabs[0];

    // Check if we have a selected area
    if (selectedArea) {
      log('Auto-test: Using selected area for capture', selectedArea);
      
      // Send message to capture the selected area
      chrome.runtime.sendMessage({
        action: 'captureViewportArea',
        area: selectedArea,
        tabId: activeTab.id,
        windowId: activeTab.windowId
      }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          updateStatus(STATUS.ERROR, 'Auto-capture of area failed');
          log('Auto-capture of area failed', chrome.runtime.lastError || response?.error);
          // Clear flag
          localStorage.removeItem('autoTestMode');
          return;
        }
        
        log('Auto-capture of area initiated successfully');
        // The capture complete handler will automatically trigger analysis
      });
    } else {
      // No area selected, capture viewport
      log('Auto-test: No area selected, capturing entire viewport');
      chrome.runtime.sendMessage({
        action: 'captureViewport',
        tabId: activeTab.id,
        windowId: activeTab.windowId
      }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
          updateStatus(STATUS.ERROR, 'Auto-capture failed');
          log('Auto-capture failed', chrome.runtime.lastError || response?.error);
          // Clear flag
          localStorage.removeItem('autoTestMode');
          return;
        }
        
        log('Auto-capture initiated successfully');
        // The capture complete handler will automatically trigger analysis
      });
    }
  });
}

// Function to start the state update timer - make more frequent updates
function startStateUpdateTimer() {
  // Clear any existing timer
  if (stateUpdateTimer) {
    clearInterval(stateUpdateTimer);
    stateUpdateTimer = null;
  }
  
  // First update immediately
  requestStateUpdate();
  
  // Set up timer to refresh state every 2 seconds (more frequent updates)
  stateUpdateTimer = setInterval(requestStateUpdate, 2000);
  
  log('State update timer started (2s interval)');
}

// Function to request a state update from the background
function requestStateUpdate() {
  if (!currentSession || !currentSession.status) {
    return; // Don't request if we don't have a session
  }
  
  // Request current state from background
  chrome.runtime.sendMessage({ action: 'getCurrentState' }, (response) => {
    if (chrome.runtime.lastError) {
      log('Error requesting state update:', chrome.runtime.lastError);
      return;
    }
    
    if (!response || !response.state) {
      log('No state received from background');
      return;
    }
    
    const bgState = response.state;
    
    // Critical: Only update if background has a current session - otherwise we might lose our session
    if (bgState.currentSession) {
      // Check if the sessions match
      if (bgState.currentSession.id === currentSession.id) {
        log(`Updating from background - captures: ${bgState.currentSession.captureCount}, status: ${bgState.currentSession.status}`);
        
        // Preserve our session's active status if needed
        if (currentSession.status === 'active' && bgState.currentSession.status !== 'active') {
          log('CRITICAL: Background session not active, but popup session is active - preserving active status');
          bgState.currentSession.status = 'active';
          
          // Send active status back to background
          chrome.runtime.sendMessage({
            action: 'updateSessionSettings',
            settings: { forceStatusActive: true }
          });
        }
        
        // Update our session data
        currentSession.captureCount = bgState.currentSession.captureCount || currentSession.captureCount || 0;
        currentSession.lastCaptureTime = bgState.currentSession.lastCaptureTime || currentSession.lastCaptureTime;
        currentSession.apiCallCount = bgState.currentSession.apiCallCount || currentSession.apiCallCount || 0;
        currentSession.rateLimitCount = bgState.currentSession.rateLimitCount || currentSession.rateLimitCount || 0;
        
        // Update next scheduled capture time and start countdown if needed
        if (bgState.currentSession.nextScheduledCapture) {
          currentSession.nextScheduledCapture = bgState.currentSession.nextScheduledCapture;
          
          // If countdown is not running, start it
          if (!captureCountdownTimer && currentSession.status === 'active') {
            startCaptureCountdown();
          }
        }
        
        // Update status
        if (bgState.currentSession.nextScheduledCapture && currentSession.status === 'active') {
          const nextCapture = new Date(bgState.currentSession.nextScheduledCapture);
          const now = new Date();
          const secondsUntilNext = Math.max(0, Math.round((nextCapture - now) / 1000));
          
          if (secondsUntilNext > 0) {
            updateStatus(STATUS.ACTIVE, `Next capture in ${secondsUntilNext}s`);
          }
        }
        
        // Update UI to reflect new values
        updateSessionUI();
        
        // Save session locally
        saveSession(currentSession);
      } else {
        // Different session - check if we should adopt the background's session
        if (!currentSession || bgState.currentSession.startTime > currentSession.startTime) {
          log('Adopting newer session from background');
          currentSession = bgState.currentSession;
          updateSessionUI();
          
          // If session is active, ensure timer is running
          if (currentSession.status === 'active' && !sessionTimer) {
            startSessionTimer();
          }
          
          // If session is active, ensure capture countdown is running
          if (currentSession.status === 'active' && currentSession.nextScheduledCapture) {
            startCaptureCountdown();
          }
        }
      }
    } else if (bgState.status) {
      // Just update status message
      updateStatus(bgState.status.type, bgState.status.message);
    }
  });
}

// Function to stop the state update timer
function stopStateUpdateTimer() {
  if (stateUpdateTimer) {
    clearInterval(stateUpdateTimer);
    stateUpdateTimer = null;
    log('State update timer stopped');
  }
}

// Add a new countdown timer variable
let captureCountdownTimer = null;

// Function to start countdown until next capture
function startCaptureCountdown(targetTimestamp) {
  log('Starting capture countdown to:', new Date(targetTimestamp).toLocaleTimeString());

  // Clear any existing countdown timer
  if (captureCountdownTimer) {
    clearInterval(captureCountdownTimer);
  }

  // Function to update the countdown
  function updateCaptureCountdown() {
    const now = Date.now();
    const timeLeft = targetTimestamp - now;
    
    if (timeLeft <= 0) {
      domElements.nextCaptureTimer.textContent = 'Due now';
      domElements.nextCaptureTimer.classList.remove('bg-primary');
      domElements.nextCaptureTimer.classList.add('bg-warning');
    } else {
      const seconds = Math.ceil(timeLeft / 1000);
      if (seconds < 10) {
        domElements.nextCaptureTimer.classList.remove('bg-primary');
        domElements.nextCaptureTimer.classList.add('bg-warning');
      } else {
        domElements.nextCaptureTimer.classList.add('bg-primary');
        domElements.nextCaptureTimer.classList.remove('bg-warning');
      }
      
      // Format countdown as mm:ss
      const minutes = Math.floor(seconds / 60);
      const remainingSeconds = seconds % 60;
      const formattedTime = `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
      
      domElements.nextCaptureTimer.textContent = formattedTime;
    }
  }

  // Update immediately first
  updateCaptureCountdown();

  // Then set interval to update every second
  captureCountdownTimer = setInterval(updateCaptureCountdown, 1000);
}

// Update the session state handling when receiving a session update
function handleSessionUpdate(sessionData) {
  if (!sessionData) {
    // Session ended or null data
    log('Session update - no session data');
    currentSession = null;
    updateSessionUI();
    stopSessionTimer();
    return;
  }

  // Save reference to current session
  currentSession = sessionData;
  
  // Update UI based on session state
  updateSessionUI();
  
  // Start/update session timer if active
  if (currentSession.status === 'active') {
    startSessionTimer();
    
    // Handle countdown timer for next capture if we have a next scheduled time
    if (currentSession.nextScheduledCapture) {
      // Start or restart countdown to next capture
      startCaptureCountdown(new Date(currentSession.nextScheduledCapture).getTime());
    }
  } else if (currentSession.status === 'paused') {
    stopSessionTimer();
    
    // Also stop countdown timer
    if (window.captureCountdownTimer) {
      clearInterval(window.captureCountdownTimer);
      window.captureCountdownTimer = null;
      domElements.nextCaptureTimer.textContent = '--';
    }
  }
}

// Handle export all history
function handleExportAllHistory() {
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES, STORAGE_KEYS.SESSIONS], (result) => {
    let responses = result[STORAGE_KEYS.RESPONSES] || [];
    let sessions = result[STORAGE_KEYS.SESSIONS] || [];
    
    const sessionId = domElements.sessionFilter.value;
    
    // Filter responses by session if needed
    if (sessionId !== 'all') {
      responses = responses.filter(r => r.sessionId === sessionId);
    }
    
    if (responses.length === 0) {
      alert('No history data to export.');
      return;
    }
    
    // Create exportable data with sessions and responses
    const exportData = {
      exportedAt: new Date().toISOString(),
      sessions: sessions,
      responses: responses.map(response => ({
        id: response.id,
        sessionId: response.sessionId,
        timestamp: response.timestamp,
        model: response.model,
        prompt: response.prompt,
        response: response.responseText,
        imageSize: response.imageSize,
        imageData: response.imageData // Base64 encoded image data
      }))
    };
    
    // Create download link
    const dataStr = JSON.stringify(exportData, null, 2);
    const blob = new Blob([dataStr], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    
    const filename = sessionId === 'all' ? 
      `all-history-${formatDateTime(new Date()).replace(/[: ]/g, '-')}.json` : 
      `session-${sessionId}-${formatDateTime(new Date()).replace(/[: ]/g, '-')}.json`;
    
    // Create temporary link and trigger download
    const a = document.createElement('a');
    a.setAttribute('href', url);
    a.setAttribute('download', filename);
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
    
    log(`Exported ${responses.length} responses${sessionId !== 'all' ? ' for session ' + sessionId : ''}`);
  });
}

// Function to update cost estimate based on current model and image size
function updateCostEstimate() {
  if (!pixelCounter.total) return;
  
  const modelId = domElements.vlmModel.value;
  log('Updating cost estimate for model:', modelId);
  
  if (!COST_ESTIMATES[modelId]) {
    log('Warning: No cost data found for model:', modelId);
    log('Available cost estimates:', Object.keys(COST_ESTIMATES));
  }
  
  const modelCosts = COST_ESTIMATES[modelId] || { inputCost: 0.00001, outputCost: 0.00002, imageInputCost: 0.005, isPixelBased: false };
  
  // Log the model costs being used
  log('Using model costs:', modelCosts);
  
  // Calculate image input cost based on pricing model
  let imageInputCost;
  if (modelCosts.isPixelBased) {
    // If pixel-based pricing, multiply by total pixels
    imageInputCost = pixelCounter.total * modelCosts.imageInputCost;
    log('Using pixel-based pricing: ' + pixelCounter.total + ' pixels at $' + modelCosts.imageInputCost + ' per pixel');
  } else {
    // If per-image pricing, use the flat rate
    imageInputCost = modelCosts.imageInputCost;
    log('Using per-image pricing: $' + modelCosts.imageInputCost + ' per image');
  }
  
  // Estimate output tokens - typically 250 tokens of output per analysis
  const estimatedOutputTokens = 250;
  const outputCost = estimatedOutputTokens * modelCosts.outputCost;
  
  // Calculate total cost
  const totalCost = imageInputCost + outputCost;
  
  // Log the calculated costs
  log('Calculated costs:', { imageInputCost, outputCost, totalCost });
  
  // Update dimension and pixel info in both tabs
  // Update in Capture tab
  if (domElements.dimensionsText) {
    domElements.dimensionsText.textContent = `${pixelCounter.width} x ${pixelCounter.height} px`;
  }
  if (domElements.pixelsText) {
    domElements.pixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
  }
  
  // Update in Monitor tab
  if (domElements.monitorDimensionsText) {
    domElements.monitorDimensionsText.textContent = `${pixelCounter.width} x ${pixelCounter.height} px`;
  }
  if (domElements.monitorPixelsText) {
    domElements.monitorPixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
  }
  
  // Update cost displays
  // Original cost display in selection info
  if (domElements.costText) {
    domElements.costText.textContent = `$${totalCost.toFixed(6)}`;
    domElements.imageInputCostText.textContent = `$${imageInputCost.toFixed(6)}`;
    domElements.outputCostText.textContent = `$${outputCost.toFixed(6)}`;
    domElements.costText.title = `Image Input: $${imageInputCost.toFixed(6)}\nText Output: $${outputCost.toFixed(6)}`;
  } else {
    log('Warning: costText element not found');
  }
  
  // Update cost in Capture tab
  if (domElements.captureCostText) {
    domElements.captureCostText.textContent = `$${totalCost.toFixed(6)}`;
    domElements.captureImageInputCostText.textContent = `$${imageInputCost.toFixed(6)}`;
    domElements.captureOutputCostText.textContent = `$${outputCost.toFixed(6)}`;
  } else {
    log('Warning: captureCostText element not found');
  }
  
  // Update cost in Monitor tab
  if (domElements.monitorCostText) {
    domElements.monitorCostText.textContent = `$${totalCost.toFixed(6)}`;
    domElements.monitorImageInputCostText.textContent = `$${imageInputCost.toFixed(6)}`;
    domElements.monitorOutputCostText.textContent = `$${outputCost.toFixed(6)}`;
  } else {
    log('Warning: monitorCostText element not found');
  }
  
  return totalCost;
}

// New function to show default cost estimate based on model when no image is captured yet
function updateDefaultCostEstimate() {
  if (!pixelCounter.width || !pixelCounter.height) {
    return;
  }
  
  const modelId = domElements.vlmModel.value;
  const modelCosts = COST_ESTIMATES[modelId] || { inputCost: 0.00001, outputCost: 0.00002, imageInputCost: 0.005, isPixelBased: false };
  
  // Calculate image input cost based on pricing model
  let imageInputCost;
  if (modelCosts.isPixelBased) {
    // If pixel-based pricing, multiply by total pixels
    imageInputCost = pixelCounter.total * modelCosts.imageInputCost;
  } else {
    // If per-image pricing, use the flat rate
    imageInputCost = modelCosts.imageInputCost;
  }
  
  // Estimate output tokens - typically 250 tokens of output per analysis
  const estimatedOutputTokens = 250;
  const outputCost = estimatedOutputTokens * modelCosts.outputCost;
  
  // Calculate total cost
  const totalCost = imageInputCost + outputCost;
  
  // Update dimension and pixel info in both tabs
  // Update in Capture tab
  if (domElements.dimensionsText) {
    domElements.dimensionsText.textContent = `${pixelCounter.width} x ${pixelCounter.height} px`;
  }
  if (domElements.pixelsText) {
    domElements.pixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
  }
  
  // Update in Monitor tab
  if (domElements.monitorDimensionsText) {
    domElements.monitorDimensionsText.textContent = `${pixelCounter.width} x ${pixelCounter.height} px`;
  }
  if (domElements.monitorPixelsText) {
    domElements.monitorPixelsText.textContent = `${pixelCounter.total.toLocaleString()} px`;
  }
  
  // Update cost displays
  // Original cost display in selection info
  if (domElements.costText) {
    domElements.costText.textContent = `$${totalCost.toFixed(6)}`;
    domElements.imageInputCostText.textContent = `$${imageInputCost.toFixed(6)}`;
    domElements.outputCostText.textContent = `$${outputCost.toFixed(6)}`;
    domElements.costText.title = `Image Input: $${imageInputCost.toFixed(6)}\nText Output: $${outputCost.toFixed(6)}`;
  }
  
  // Update cost in Capture tab
  if (domElements.captureCostText) {
    domElements.captureCostText.textContent = `$${totalCost.toFixed(6)}`;
    domElements.captureImageInputCostText.textContent = `$${imageInputCost.toFixed(6)}`;
    domElements.captureOutputCostText.textContent = `$${outputCost.toFixed(6)}`;
  }
  
  // Update cost in Monitor tab
  if (domElements.monitorCostText) {
    domElements.monitorCostText.textContent = `$${totalCost.toFixed(6)}`;
    domElements.monitorImageInputCostText.textContent = `$${imageInputCost.toFixed(6)}`;
    domElements.monitorOutputCostText.textContent = `$${outputCost.toFixed(6)}`;
  }
}

// Initialize DOM elements after document is loaded
function initializeDOMElements() {
  // Capture Tab Elements
  domElements.captureViewport = document.getElementById('captureViewport');
  domElements.captureArea = document.getElementById('captureArea');
  domElements.vlmModel = document.getElementById('vlmModel');
  domElements.promptText = document.getElementById('promptText');
  domElements.analyzeImage = document.getElementById('analyzeImage');
  domElements.previewContainer = document.getElementById('previewContainer');
  domElements.previewImage = document.getElementById('previewImage');
  domElements.responseContainer = document.getElementById('responseContainer');
  domElements.responseText = document.getElementById('responseText');
  domElements.selectionInfo = document.getElementById('selectionInfo');
  domElements.dimensionsText = document.getElementById('dimensionsText');
  domElements.pixelsText = document.getElementById('pixelsText');
  domElements.costText = document.getElementById('costText');
  domElements.imageInputCostText = document.getElementById('imageInputCostText');
  domElements.outputCostText = document.getElementById('outputCostText');
  
  // New Cost Estimate Elements - Capture Tab
  domElements.captureCostText = document.getElementById('captureCostText');
  domElements.captureImageInputCostText = document.getElementById('captureImageInputCostText');
  domElements.captureOutputCostText = document.getElementById('captureOutputCostText');
  
  // New Cost Estimate Elements - Monitor Tab
  domElements.monitorDimensionsText = document.getElementById('monitorDimensionsText');
  domElements.monitorPixelsText = document.getElementById('monitorPixelsText');
  domElements.monitorCostText = document.getElementById('monitorCostText');
  domElements.monitorImageInputCostText = document.getElementById('monitorImageInputCostText');
  domElements.monitorOutputCostText = document.getElementById('monitorOutputCostText');
  
  // Monitor Tab Elements
  // ... existing code ...
}

// Function to initialize the extension
async function initialize() {
  log('Initializing extension...');

  try {
    // Initialize DOM elements first
    initializeDOMElements();
    log('DOM elements initialized');
    
    // Load model data
    await loadModelData();
    log('Model data loaded');
    
    // Load saved settings
    await loadSettings();
    log('Settings loaded');
    
    // Populate model dropdown
    populateModelDropdown();
    log('Model dropdown populated');
    
    // Initialize cost estimates with default values
    updateDefaultCostEstimate();
    log('Default cost estimates calculated');
    
    // Attach event listeners
    attachEventListeners();
    log('Event listeners attached');
    
    // Add the state update timer
    stateUpdateTimer = setInterval(updateStateDisplay, 1000);
    
    log('Extension initialized successfully');
  } catch (error) {
    log('Error during initialization', error);
    updateStatus(STATUS.ERROR, 'Initialization error');
  }
}