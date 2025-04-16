// Constants
const STORAGE_KEYS = {
  SETTINGS: 'ai_watcher_settings',
  SESSIONS: 'ai_watcher_sessions',
  RESPONSES: 'ai_watcher_responses',
  IMAGES: 'ai_watcher_images',
  DEBUG: 'ai_watcher_debug'
};

// Add a state variable to track if an analysis is in progress
let isAnalysisInProgress = false;
const NEXT_CAPTURE_ALARM_NAME = 'ai_watcher_next_capture';

// Default settings
const DEFAULT_SETTINGS = {
  captureMethod: 'crop',
  vlmModel: 'moonshotai/kimi-vl-a3b-thinking:free',
  monitorInterval: 30,
  enableNotifications: true,
  autoBackoff: true,
  apiKey: '',
  debugMode: false,
  showPixelOverlay: false
};

// Global state managed by background script
let backgroundState = {
  status: { type: 'idle', message: 'Ready' },
  selectedArea: null,
  capturedImage: null, // { dataUrl, timestamp }
  currentSession: null
};

// Global message cache to store messages when popup is closed
let messageCache = {};

// Initialize offscreen document for canvas operations
async function setupOffscreenDocument() {
  // Check if we already have an offscreen document
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });
  
  if (existingContexts.length > 0) {
    log('Offscreen document already exists');
    return;
  }
  
  // Create an offscreen document for image processing
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CANVAS_IMAGE_EXTRACTION'],
      justification: 'Image processing for screenshot capture'
    });
    log('Offscreen document created for image processing');
  } catch (error) {
    log('Error creating offscreen document:', error);
  }
}

// Initialize extension
chrome.runtime.onInstalled.addListener(async () => {
  // Set default settings
  chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
    if (!result[STORAGE_KEYS.SETTINGS]) {
      chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
    }
  });
  
  // Set up context menu - only if the API is available
  if (chrome.contextMenus) {
    try {
      chrome.contextMenus.create({
        id: 'captureViewport',
        title: 'Capture Viewport',
        contexts: ['page']
      });
      
      chrome.contextMenus.create({
        id: 'captureArea',
        title: 'Select Area to Capture',
        contexts: ['page']
      });
    } catch (e) {
      console.error('Error creating context menus:', e);
    }
  }
  
  // Set up offscreen document for image manipulation
  await setupOffscreenDocument();
  
  // Log installation
  log('Extension installed');
});

// Handle context menu clicks - only if the API is available
if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'captureViewport') {
      captureViewport(tab);
    } else if (info.menuItemId === 'captureArea') {
      startAreaSelection(tab);
    }
  });
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  log('Background received message:', message, 'from:', sender.tab ? `Tab ${sender.tab.id}` : 'Popup/Other');

  // Handle messages from the original extension functionality
  if (message.message === 'capture' || message.message === 'active') {
    // Pass to original handler
    handleOriginalExtensionMessage(message, sender, res);
    return true; // Keep channel open for original handler
  }

  // Handle messages for the new functionality
  handleNewExtensionMessage(message, sender, sendResponse);
  return true; // Keep message channel open for async response
});

// Handler for new extension functionality messages
function handleNewExtensionMessage(message, sender, sendResponse) {
  switch (message.action) {
    case 'getCurrentState':
      sendResponse({ success: true, state: backgroundState });
      break;

    case 'captureViewport':
      if (!sender.tab) {
        log('No sender tab info for captureViewport, querying active tab');
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
          if (!tabs || tabs.length === 0) {
            log('No active tab found for captureViewport');
            updateBackgroundState({ status: { type: 'error', message: 'Failed to find active tab for capture' } });
            sendResponse({ success: false, error: 'No active tab found' });
            return;
          }
          captureViewport(tabs[0], { callback: sendResponse });
        });
      } else {
        captureViewport(sender.tab, { callback: sendResponse });
      }
      return true; // Keep channel open for async response
      break;

    case 'startSelection':
      // Use the tab info from the message if available (from popup)
      if (message.tabId) {
        chrome.tabs.get(message.tabId, (tab) => {
          if (chrome.runtime.lastError) {
            log('Error getting tab:', chrome.runtime.lastError);
            updateBackgroundState({ status: { type: 'error', message: 'Failed to find tab' } });
            sendResponse({ success: false, error: 'Tab not found' });
          } else {
            startAreaSelection(tab);
            sendResponse({ success: true });
          }
        });
      } else {
        // Fallback to sender tab (from content script)
        startAreaSelection(sender.tab);
        sendResponse({ success: true });
      }
      break;

    case 'areaSelected': // Message from content script
      handleAreaSelected(message.data, sender.tab);
      sendResponse({ success: true });
      break;

    case 'captureViewportArea':
      // Get tab info from message
      const tabId = message.tabId;
      const windowId = message.windowId;

      const tab = { id: tabId, windowId: windowId };
      
      // See if there's an area in the message
      if (message.area) {
        log('Message contains area, using that:', message.area);
        // Pass the additional options from the message for auto-analysis
        captureViewportArea(message.area, tab, {
          autoAnalyze: message.autoAnalyze,
          monitorSession: message.monitorSession
        });
        sendResponse({ success: true });
      } else if (backgroundState.selectedArea) {
        log('Using area from background state:', backgroundState.selectedArea);
        // Pass the additional options from the message for auto-analysis
        captureViewportArea(backgroundState.selectedArea, tab, {
          autoAnalyze: message.autoAnalyze,
          monitorSession: message.monitorSession
        });
        sendResponse({ success: true });
      } else {
        log('No area found in message or background state');
        sendResponse({ success: false, error: 'No selected area found' });
      }
      return true;

    case 'analyzeImage':
      analyzeImage(message.payload, message.apiKey, message.metadata);
      sendResponse({ success: true });
      break;

    case 'testApiConnection':
      testApiConnection(message.payload, message.apiKey)
        .then(data => sendResponse({ success: true, data }))
        .catch(error => sendResponse({ success: false, error }));
      break;

    case 'customApiRequest':
      makeApiRequest(message.endpoint, message.payload, message.apiKey)
        .then(data => sendResponse({ success: true, data }))
        .catch(error => sendResponse({ success: false, error }));
      break;

    case 'showNotification':
      showNotification(message.title, message.message);
      sendResponse({ success: true });
      break;

    // Session management messages from popup
    case 'startSession':
      // Pass tabId and windowId from message to handleStartSession
      handleStartSession(
        message.selectedArea, 
        message.prompt, 
        { 
          conversationMode: message.conversationMode,
          tabId: message.tabId,
          windowId: message.windowId
        }
      );
      sendResponse({ success: true, session: backgroundState.currentSession });
      break;
    case 'pauseSession':
      handlePauseSession();
      sendResponse({ success: true, session: backgroundState.currentSession });
      break;
    case 'stopSession':
      handleStopSession();
      sendResponse({ success: true, session: backgroundState.currentSession });
      break;
    case 'updateSessionSettings': // e.g., interval change
      handleUpdateSessionSettings(message.settings);
      sendResponse({ success: true });
      break;

    case 'resumeSession':
      const resumeResult = handleResumeSessionLogic();
      sendResponse(resumeResult);
      break;

    default:
      log('Unknown action in new handler:', message.action);
      sendResponse({ success: false, error: 'Unknown action' });
      break;
  }
}

// Handler for original extension messages (moved to its own function)
function handleOriginalExtensionMessage(req, sender, res) {
  if (req.message === 'capture') {
    chrome.tabs.query({active: true, currentWindow: true}, (tab) => {
        // Ensure we have a valid tab ID
        const tabId = tab?.[0]?.id;
        if (!tabId) {
            log('Original capture: No active tab found');
            res({ error: 'No active tab found' });
            return;
        }
        chrome.tabs.captureVisibleTab(tab[0].windowId, {format: req.format, quality: req.quality}, (image) => {
          if (chrome.runtime.lastError) {
            log('Original capture error:', chrome.runtime.lastError);
            res({ error: chrome.runtime.lastError.message });
            return;
          }
          res({message: 'image', image});
        });
      });
    } else if (req.message === 'active') {
    if (req.active) {
      chrome.storage.sync.get((config) => {
          const tabId = sender.tab?.id;
          if (!tabId) return;
          let title = 'Screenshot Capture'; // Default
          let badge = '';
          if (config.method === 'crop') { title = 'Crop and Save'; badge = '◩'; }
          else if (config.method === 'wait') { title = 'Crop and Wait'; badge = '◪'; }
          else if (config.method === 'view') { title = 'Capture Viewport'; badge = '⬒'; }
          else if (config.method === 'page') { title = 'Capture Document'; badge = '◼'; }
          chrome.action.setTitle({tabId: tabId, title: title});
          chrome.action.setBadgeText({tabId: tabId, text: badge});
        });
      } else {
        const tabId = sender.tab?.id;
        if (!tabId) return;
        chrome.action.setTitle({tabId: tabId, title: 'Screenshot Capture'});
        chrome.action.setBadgeText({tabId: tabId, text: ''});
      }
      // Send response immediately for 'active' message
      res({ success: true });
    } else {
        // Should not happen based on initial check, but good practice
        res({ success: false, error: 'Unknown original message type' });
    }
    // Important: Return true only if response is async (like capture)
    return req.message === 'capture';
}

// Update background state and notify popup
function updateBackgroundState(newState) {
  backgroundState = { ...backgroundState, ...newState };
  log('Background state updated:', backgroundState);

  // Broadcast specific state changes to popup if needed
  if ('status' in newState) {
    broadcastMessage({ action: 'updateStatus', status: backgroundState.status.type, message: backgroundState.status.message });
  }
  if ('selectedArea' in newState) {
    broadcastMessage({ action: 'areaSelected', data: backgroundState.selectedArea });
  }
  if ('capturedImage' in newState) {
    // Send capture complete, indicating not to re-analyze if just updating state
    broadcastMessage({ action: 'captureComplete', data: backgroundState.capturedImage, analyze: false });
  }
  if ('currentSession' in newState) {
    broadcastMessage({ action: 'sessionUpdate', session: backgroundState.currentSession });
  }
}

// Completely rewrite the monitoring alarm functionality to be more reliable
function startMonitoringAlarm() {
    if (!backgroundState.currentSession) return;
    
    // Clear any existing alarms to avoid duplicates
    chrome.alarms.clear(NEXT_CAPTURE_ALARM_NAME, (wasCleared) => {
        log(`Previous monitoring alarm cleared: ${wasCleared}`);
        
        // Set isAnalysisInProgress to false to start fresh
        isAnalysisInProgress = false;
        
        // Schedule the first capture immediately
        scheduleNextMonitoringCapture(false, 0); // 0 seconds delay for the first capture
        
        log(`Sequential monitoring initialized for session: ${backgroundState.currentSession.id}`);
    });
}

// Define the alarm handler for sequential monitoring
function handleSequentialMonitoringAlarm(alarm) {
    if (alarm.name === NEXT_CAPTURE_ALARM_NAME) {
        log(`Alarm '${NEXT_CAPTURE_ALARM_NAME}' fired at: ${new Date().toLocaleTimeString()}`);
        
        if (isAnalysisInProgress) {
            log('Analysis already in progress, not starting another capture cycle.');
            return;
        }
        
        // Set the busy flag at the start of the process
        isAnalysisInProgress = true;
        
        // Update UI to show we're processing
        updateBackgroundState({ status: { type: 'processing', message: 'Capturing for monitoring...' } });
        
        captureForMonitoring();
    }
    else if (alarm.name === 'resumeMonitoring') {
        log('Resuming monitoring after backoff.');
        // Check if the session is still supposed to be active
        if (backgroundState.currentSession?.status === 'active') {
            updateBackgroundState({ status: { type: 'active', message: 'Monitoring resumed after backoff' } });
            // Schedule the next capture
            scheduleNextMonitoringCapture();
        } else {
            log('Session changed/stopped during backoff, not resuming.');
        }
    }
}

// Remove any existing listeners and add the new alarm listener
try {
  // Try to safely remove any existing alarm listeners
  chrome.alarms.onAlarm.removeListener(handleSequentialMonitoringAlarm);
  
  // Safe way to try removing other potential listeners without causing errors
  if (typeof handleMonitoringAlarm !== 'undefined') {
    chrome.alarms.onAlarm.removeListener(handleMonitoringAlarm);
  }
} catch (err) {
  log('Error cleaning up alarm listeners:', err);
}

// Add our new alarm listener
chrome.alarms.onAlarm.addListener(handleSequentialMonitoringAlarm);

// Update the stop function to clear both alarms
function stopMonitoringAlarm() {
    chrome.alarms.clear(NEXT_CAPTURE_ALARM_NAME);
    chrome.alarms.clear('resumeMonitoring');
    isAnalysisInProgress = false; // Clear busy flag
    log('All monitoring alarms cleared');
}

// Capture viewport
function captureViewport(tab, options = {}) {
  updateBackgroundState({ status: { type: 'processing', message: 'Capturing viewport...' } });
  
  // If tab info is missing, log error and notify caller
  if (!tab || !tab.windowId) {
    const errorMsg = 'Missing tab or windowId for capture';
    log(errorMsg);
    updateBackgroundState({ status: { type: 'error', message: 'Failed to capture: Missing tab info' } });
    
    // Notify caller of failure if callback provided
    if (options.callback) {
      options.callback({ success: false, error: errorMsg });
    }
    
    // Clear busy flag and schedule next if this was for monitoring
    if (options.monitorSession) {
      isAnalysisInProgress = false;
      scheduleNextMonitoringCapture(true);
    }
    return;
  }
  
  log(`Capturing viewport from window ${tab.windowId}`);
  
  chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      const error = chrome.runtime.lastError.message || 'Unknown error';
      log('Error capturing viewport', chrome.runtime.lastError);
      updateBackgroundState({ status: { type: 'error', message: 'Failed to capture viewport: ' + error } });
      
      // Notify caller of failure if callback provided
      if (options.callback) {
        options.callback({ success: false, error: error });
      }
      
      // Clear busy flag and schedule next if this was for monitoring
      if (options.monitorSession) {
        isAnalysisInProgress = false;
        scheduleNextMonitoringCapture(true);
      }
      return;
    }
    
    const capturedData = { dataUrl, timestamp: new Date().toISOString() };
    
    // Update background state with the captured image
    updateBackgroundState({ 
      capturedImage: capturedData, 
      status: { type: 'active', message: 'Viewport captured' } 
    });
    
    // Process the captured image with the provided options
    handleCapturedImage(capturedData, null, options);
    
    log('Viewport captured successfully');
    
    // Notify caller of success if callback provided
    if (options.callback) {
      options.callback({ success: true, data: capturedData });
    }
  });
}

// Start area selection in content script
function startAreaSelection(tab) {
  // If no tab provided, query for active tab first
  if (!tab || !tab.id) {
    log('No tab provided directly, querying for active tab');
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs || tabs.length === 0) {
        log('No active tab found in query');
        updateBackgroundState({ status: { type: 'error', message: 'No active tab found' } });
        return;
      }
      const activeTab = tabs[0];
      if (!activeTab.id) {
        log('Active tab has no ID');
        updateBackgroundState({ status: { type: 'error', message: 'Invalid tab ID' } });
        return;
      }
      // Now call with the proper tab
      startAreaSelection(activeTab);
    });
    return;
  }
  
  updateBackgroundState({ status: { type: 'active', message: 'Select area on page...' } });
  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['content/index.js'] // Ensure content script is injected
  }).then(() => {
     chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/index.css'] });
     // Now send the message to start selection
     chrome.tabs.sendMessage(tab.id, { action: 'startSelection' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) {
            log('Failed to start selection in content script:', chrome.runtime.lastError || response?.error);
            updateBackgroundState({ status: { type: 'error', message: 'Failed to start selection' } });
        } else {
            log('Content script selection started');
        }
     });
  }).catch(error => {
    log('Error injecting script/CSS for area selection', error);
    updateBackgroundState({ status: { type: 'error', message: 'Failed to inject script' } });
  });
}

// Handle area selected event from content script
function handleAreaSelected(data, tab) {
  log('Area selected data received', data);
  
  // Update background state
  updateBackgroundState({ 
    selectedArea: data, 
    status: { type: 'active', message: 'Area selected' } 
  });
  
  // Also update the current session if active
  if (backgroundState.currentSession && backgroundState.currentSession.status === 'active') {
    backgroundState.currentSession.selectedArea = data;
    updateBackgroundState({ currentSession: backgroundState.currentSession });
    saveSession(backgroundState.currentSession);
    
    // Broadcast the updated session to ensure popup is in sync
    broadcastMessage({
      action: 'sessionUpdate',
      session: backgroundState.currentSession
    });
    
    log('Updated selected area in active session');
  }
  
  // Immediately capture the selected area, even if popup is closed
  log('Auto-capturing the selected area after selection');
  captureViewportArea(data, tab, { autoCapture: true });
}

// Capture viewport area based on selection
function captureViewportArea(area, tab, options = {}) {
  // Validate area parameter
  if (!area || typeof area !== 'object' || !area.width || !area.height) {
    const errorMsg = 'Invalid area parameter for capture';
    log(errorMsg, area);
    updateBackgroundState({ status: { type: 'warning', message: 'Invalid selection area' } });
    
    // Notify caller of failure
    if (options.callback) {
      options.callback({ success: false, error: errorMsg });
    }
    
    // Clear busy flag and schedule next if this was for monitoring
    if (options.monitorSession) {
      isAnalysisInProgress = false;
      scheduleNextMonitoringCapture(true);
    }
    return;
  }
  
  // Normalize area properties - handle different naming conventions from content script
  const normalizedArea = {
    left: area.left || area.x || 0,
    top: area.top || area.y || 0,
    width: area.width || area.w || 0,
    height: area.height || area.h || 0,
    devicePixelRatio: area.devicePixelRatio || window.devicePixelRatio || 1
  };
  
  log('captureViewportArea called with normalized area:', normalizedArea);
  updateBackgroundState({ status: { type: 'processing', message: 'Capturing selected area...' } });
  
  // Ensure we have tab info
  if (!tab || !tab.windowId) {
    log('Missing tab info for captureViewportArea, querying active tab');
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs || tabs.length === 0) {
        const errorMsg = 'No active tab found for captureViewportArea';
        log(errorMsg);
        updateBackgroundState({ status: { type: 'error', message: 'Failed to find active tab for capture' } });
        
        // Notify caller of failure
        if (options.callback) {
          options.callback({ success: false, error: errorMsg });
        }
        
        // Clear busy flag and schedule next if this was for monitoring
        if (options.monitorSession) {
          isAnalysisInProgress = false;
          scheduleNextMonitoringCapture(true);
        }
        return;
      }
      // Recursive call with proper tab
      log('Found active tab, retrying captureViewportArea');
      captureViewportArea(normalizedArea, tabs[0], options);
    });
    return;
  }
  
  log('Capturing viewport from tab:', tab.id, 'window:', tab.windowId);
  
  // Ensure we're capturing from the proper window
  chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      const errorMsg = `Error capturing viewport for area crop: ${chrome.runtime.lastError.message}`;
      log(errorMsg, chrome.runtime.lastError);
      updateBackgroundState({ status: { type: 'error', message: 'Failed to capture for crop' } });
      
      // Notify caller of failure
      if (options.callback) {
        options.callback({ success: false, error: errorMsg });
      }
      
      // Clear busy flag and schedule next if this was for monitoring
      if (options.monitorSession) {
        isAnalysisInProgress = false;
        scheduleNextMonitoringCapture(true);
      }
      return;
    }

    log('Successfully captured viewport, proceeding to crop', { windowId: tab.windowId });
    
    // Try to crop the image in the background first
    cropImage(dataUrl, normalizedArea)
      .then(croppedDataUrl => {
        log('Image cropped successfully in background, size:', croppedDataUrl.length);
        const capturedData = { dataUrl: croppedDataUrl, timestamp: new Date().toISOString() };
        
        // Notify caller of success if callback provided
        if (options.callback) {
          options.callback({ success: true, data: capturedData });
        }
        
        handleCapturedImage(capturedData, normalizedArea, options);
      })
      .catch(error => {
        log('Error cropping image in background, trying content script method', error);
        
        // Try the content script method as a first fallback
        cropImageInContentScript(tab.id, dataUrl, normalizedArea)
          .then(croppedDataUrl => {
            log('Image cropped successfully in content script, size:', croppedDataUrl.length);
            const capturedData = { dataUrl: croppedDataUrl, timestamp: new Date().toISOString() };
            
            // Notify caller of success if callback provided
            if (options.callback) {
              options.callback({ success: true, data: capturedData });
            }
            
            handleCapturedImage(capturedData, normalizedArea, options);
          })
          .catch(contentError => {
            log('Content script cropping also failed, using full viewport as fallback', contentError);
            
            // FALLBACK - Use the full viewport image instead of failing
            log('FALLBACK: Using full viewport image instead of cropped area');
            const fallbackData = { 
              dataUrl: dataUrl, 
              timestamp: new Date().toISOString(),
              isFallback: true
            };
            
            // Update with the full image
            updateBackgroundState({
              capturedImage: fallbackData,
              status: { type: 'warning', message: 'Using full viewport (cropping failed)' }
            });
            
            // Notify caller with fallback data
            if (options.callback) {
              options.callback({ 
                success: true, 
                data: fallbackData,
                warning: 'Using full viewport as fallback' 
              });
            }
            
            // Send the full image to popup
            broadcastMessage({
              action: 'captureComplete',
              data: fallbackData,
              analyze: false
            });
            
            // Try direct message too
            chrome.runtime.sendMessage({
              action: 'captureComplete',
              data: fallbackData,
              analyze: false
            }).catch(err => {
              log('Direct fallback message failed:', err);
            });
            
            // If this was for monitoring, handle the error and schedule next
            if (options.monitorSession) {
              // Still consider this a partial success for monitoring
              handleCapturedImage(fallbackData, null, options);
            }
          });
      });
  });
}

// Helper function to handle captured image processing
function handleCapturedImage(capturedData, area, options = {}) {
  // Update background state with the captured image
  updateBackgroundState({ 
    capturedImage: capturedData, 
    status: { type: 'active', message: 'Area captured' }
  });
  
  // Explicitly broadcast the capture complete message to ensure popup gets it
  try {
    log('Broadcasting captureComplete message');
    broadcastMessage({ 
      action: 'captureComplete', 
      data: capturedData,
      analyze: options?.analyze !== undefined ? options.analyze : false
    });
    
    // Send an extra direct message to ensure the popup receives it
    chrome.runtime.sendMessage({ 
      action: 'captureComplete', 
      data: capturedData,
      analyze: options?.analyze !== undefined ? options.analyze : false
    }).catch(err => {
      // This might fail if popup is not open, which is fine
      log('Direct captureComplete message failed (normal if popup closed):', err);
    });
    
    // If this is a monitoring capture with autoAnalyze flag, analyze it automatically
    if (options?.autoAnalyze === true && options?.monitorSession) {
      log('Auto-analyzing captured image for monitoring session', options.monitorSession);
      
      // Get the monitoring session info
      const sessionInfo = options.monitorSession;
      const prompt = sessionInfo.prompt || 'Analyze this image';
      
      // If in conversation mode, prepend history to the prompt
      let finalPrompt = prompt;
      if (sessionInfo.conversationMode && backgroundState.currentSession?.conversationHistory?.length > 0) {
        const history = backgroundState.currentSession.conversationHistory;
        
        // Format conversation history
        finalPrompt = `Previous conversation:\n${history.join('\n\n')}\n\nNew image:\n${prompt}`;
        log('Using conversation mode prompt with history', { historyLength: history.length });
      }
      
      // Find API key in settings
      chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
        const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
        const apiKey = settings.apiKey?.trim() || DEFAULT_SETTINGS.apiKey;
        
        // Create payload for analysis
        const payload = {
          model: settings.vlmModel || DEFAULT_SETTINGS.vlmModel,
          prompt: finalPrompt,
          imageDataUrl: capturedData.dataUrl
        };
        
        // Send for analysis
        log('Auto-analyzing with prompt:', finalPrompt);
        analyzeImage(payload, apiKey, {
          prompt: finalPrompt,
          sessionId: sessionInfo.sessionId,
          isMonitoring: true,
          conversationMode: sessionInfo.conversationMode
        });
      });
    }
  } catch (err) {
    log('Error in handleCapturedImage:', err);
  }
}

// Function to crop an image in the content script context
function cropImageInContentScript(tabId, dataUrl, area) {
  return new Promise((resolve, reject) => {
    if (!tabId) {
      reject(new Error('No tab ID provided for content script cropping'));
      return;
    }
    
    log('Attempting to crop image in content script context');
    
    // Set a timeout for the operation
    const timeout = setTimeout(() => {
      reject(new Error('Content script crop timed out'));
    }, 5000);
    
    // Execute a function in the content script context to do the cropping
    chrome.scripting.executeScript({
      target: { tabId },
      func: (imageDataUrl, cropArea) => {
        return new Promise((resolveInPage, rejectInPage) => {
          try {
            console.log('Content script crop started with area:', cropArea);
            
            // Create an image element to load the data URL
            const img = new Image();
            img.onload = () => {
              try {
                // Calculate the final coordinates
                const scaleFactor = cropArea.devicePixelRatio || window.devicePixelRatio || 1;
                
                // Create a canvas for cropping
                const canvas = document.createElement('canvas');
                canvas.width = cropArea.width;
                canvas.height = cropArea.height;
                
                const ctx = canvas.getContext('2d');
                if (!ctx) {
                  rejectInPage('Failed to get canvas context in content script');
                  return;
                }
                
                // Fill with white background (in case of transparency)
                ctx.fillStyle = '#FFFFFF';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                
                // Draw the cropped portion of the image
                ctx.drawImage(
                  img,
                  cropArea.left * scaleFactor,
                  cropArea.top * scaleFactor,
                  cropArea.width * scaleFactor, 
                  cropArea.height * scaleFactor,
                  0, 0,
                  cropArea.width, cropArea.height
                );
                
                // Get the cropped data URL
                const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.95);
                console.log('Content script cropping successful');
                
                // Clean up
                canvas.remove();
                
                resolveInPage(croppedDataUrl);
              } catch (drawError) {
                console.error('Error drawing image to canvas in content script:', drawError);
                rejectInPage('Canvas drawing failed: ' + drawError.message);
              }
            };
            
            img.onerror = (err) => {
              console.error('Failed to load image in content script:', err);
              rejectInPage('Image loading failed in content script');
            };
            
            // Start loading the image
            img.src = imageDataUrl;
            
          } catch (error) {
            console.error('General error in content script cropping:', error);
            rejectInPage('Content script crop error: ' + error.message);
          }
        });
      },
      args: [dataUrl, area]
    })
    .then(results => {
      clearTimeout(timeout);
      if (results && results[0] && results[0].result) {
        resolve(results[0].result);
      } else {
        reject(new Error('Content script cropping returned no result'));
      }
    })
    .catch(err => {
      clearTimeout(timeout);
      reject(new Error('Executing content script crop failed: ' + err.message));
    });
  });
}

// Crop image to selected area
function cropImage(dataUrl, area) {
  return new Promise(async (resolve, reject) => {
    log('Starting to crop image in offscreen document', { area });
    
    try {
      // Make sure the offscreen document is ready
      await setupOffscreenDocument();
      
      // Send message to offscreen document to crop the image
      chrome.runtime.sendMessage({
        action: 'cropImage',
        dataUrl: dataUrl,
        area: area
      }).then(response => {
        if (response && response.success) {
          log('Image cropped successfully in offscreen document');
          resolve(response.dataUrl);
        } else {
          log('Offscreen cropping failed:', response?.error || 'Unknown error');
          reject(new Error(response?.error || 'Offscreen cropping failed'));
        }
      }).catch(error => {
        log('Error sending message to offscreen document:', error);
        reject(error);
      });
    } catch (error) {
      log('Error in cropImage with offscreen document:', error);
      reject(error);
    }
  });
}

// Analyze image with VLM API
function analyzeImage(payload, apiKey, metadata) {
  updateBackgroundState({ status: { type: 'processing', message: 'Sending to VLM API...' } });

  const modelId = payload.model;
  let prompt = payload.prompt;
  const imageDataUrl = payload.imageDataUrl;
  const imageSize = metadata.imageSize || { width:0, height:0, total: 0 }; // Get size from metadata
  
  // IMPORTANT: Log the state of the session before API call for debugging
  log('Session state before API call:', {
    session: backgroundState.currentSession ? {
      id: backgroundState.currentSession.id,
      status: backgroundState.currentSession.status,
      captureCount: backgroundState.currentSession.captureCount
    } : 'No session',
    isMonitoring: metadata.isMonitoring
  });

  // Add conversation history to prompt if enabled
  if (metadata.isMonitoring && backgroundState.currentSession && 
      metadata.conversationMode && backgroundState.currentSession.conversationHistory?.length > 0) {
    const historyText = backgroundState.currentSession.conversationHistory.join('\n');
    prompt = `Conversation History:\n${historyText}\n\n---\n\nNew Query: ${prompt}`;
    log('Using conversation mode prompt with history length:', backgroundState.currentSession.conversationHistory.length);
  } else {
    log('Using standard prompt without conversation history');
  }

  // Construct the actual API payload based on provider
  let apiPayload = {};
  if (modelId.includes('anthropic')) {
    apiPayload = {
      model: modelId,
      messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageDataUrl.split(",")[1] } } ] }],
      max_tokens: 1000
    };
  } else if (modelId.includes('openai')) {
    apiPayload = {
      model: modelId,
      messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } } ] }],
      max_tokens: 1000
    };
  } else if (modelId.includes('gemini')) {
    apiPayload = {
      model: modelId,
      messages: [{ role: "user", parts: [ { text: prompt }, { inline_data: { mime_type: "image/jpeg", data: imageDataUrl.split(",")[1] } } ] }],
      max_tokens: 1000
    };
  } else if (modelId.includes('meta-llama') || modelId.includes('llama-4')) {
    apiPayload = {
      model: modelId,
      messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } } ] }],
      max_tokens: 1000
    };
  } else if (modelId.includes('moonshotai') || modelId.includes('kimi')) {
    apiPayload = {
      model: modelId,
      messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } } ] }],
      max_tokens: 1000
    };
  } else {
      // Default to OpenRouter format for unknown models
      log('Using default format for unknown model:', modelId);
      apiPayload = {
        model: modelId,
        messages: [{ role: "user", content: [ { type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl } } ] }],
        max_tokens: 1000
      };
  }

  let apiEndpoint = 'https://openrouter.ai/api/v1/chat/completions';

  // Update session stats before API call
  if (backgroundState.currentSession?.status === 'active') {
      const session = backgroundState.currentSession;
      session.apiCallCount = (session.apiCallCount || 0) + 1;
      updateBackgroundState({ currentSession: session });
      saveSession(session); // Save updated stats
  }

  // Make API request
  makeApiRequest(apiEndpoint, apiPayload, apiKey)
    .then(response => {
      // Extract response text
      let responseText = '';
      if (response.choices && response.choices[0]) {
          if (response.choices[0].message?.content) { responseText = response.choices[0].message.content; }
          else if (response.choices[0].text) { responseText = response.choices[0].text; }
      }

      const resultData = {
          id: generateId(),
          timestamp: new Date().toISOString(),
          sessionId: metadata.sessionId,
          prompt: metadata.prompt,
          imageData: imageDataUrl, // Keep original image data
          imageSize: imageSize,
          responseText: responseText,
          responseData: response, // Store full API response
          model: modelId
      };

      saveResponse(resultData); // Save the structured response

      // Handle conversation history if enabled
      if (metadata.isMonitoring && backgroundState.currentSession && 
          metadata.conversationMode && backgroundState.currentSession.conversationHistory) {
        backgroundState.currentSession.conversationHistory.push(`User: ${metadata.prompt}`);
        backgroundState.currentSession.conversationHistory.push(`AI: ${responseText}`);
        // Limit history size (e.g., last 10 exchanges = 20 entries)
        if (backgroundState.currentSession.conversationHistory.length > 20) {
          backgroundState.currentSession.conversationHistory = backgroundState.currentSession.conversationHistory.slice(-20);
        }
        updateBackgroundState({ currentSession: backgroundState.currentSession });
        saveSession(backgroundState.currentSession); // Save updated history
        log('Updated conversation history');
      }

      // IMPORTANT: Check session status after API call - ensure it's still active if this is for monitoring
      log('Session state after API call:', {
        session: backgroundState.currentSession ? {
          id: backgroundState.currentSession.id,
          status: backgroundState.currentSession.status,
          captureCount: backgroundState.currentSession.captureCount
        } : 'No session',
        isMonitoring: metadata.isMonitoring
      });
      
      // Make sure we preserve session state if this is a monitoring call
      if (metadata.isMonitoring && backgroundState.currentSession) {
        // Verify the session is still active and update status to active
        if (backgroundState.currentSession.status !== 'active') {
          log('WARNING: Session was not active after API call, restoring active state');
          backgroundState.currentSession.status = 'active';
          updateBackgroundState({ 
            currentSession: backgroundState.currentSession,
            status: { type: 'active', message: 'Analysis complete - monitoring continuing' }
          });
          saveSession(backgroundState.currentSession);
        } else {
          // Just update status message
          updateBackgroundState({ status: { type: 'active', message: 'Analysis complete - monitoring continuing' } });
        }
        
        // Schedule the next capture - sequential approach ensures it only starts after analysis completes
        scheduleNextMonitoringCapture();
      } else {
        // Standard update for non-monitoring analysis
        updateBackgroundState({ status: { type: 'active', message: 'Analysis complete' } });
        // Clear analysis flag since this wasn't for monitoring
        isAnalysisInProgress = false;
      }
      
      broadcastMessage({ action: 'analyzeComplete', data: { response: resultData } }); // Send structured response to popup
      log('VLM API request successful', { modelId });

      // If enabled, send notification
      chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (res) => {
          const settings = res[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
          if (settings.enableNotifications) {
              showNotification('Screen Scoutr', `Analysis complete: ${responseText.substring(0, 50)}...`);
          }
      });
    })
    .catch(error => {
      const isRateLimit = error.status === 429 || (error.message && error.message.includes('rate limit'));

      if (isRateLimit) {
        log('Rate limit hit during analysis');
        updateBackgroundState({ status: { type: 'warning', message: 'Rate limit hit' } });
        broadcastMessage({ action: 'rateLimitHit', data: { error, metadata } });

        // Update session stats for rate limit
        if (backgroundState.currentSession?.status === 'active') {
            const session = backgroundState.currentSession;
            session.rateLimitCount = (session.rateLimitCount || 0) + 1;
            updateBackgroundState({ currentSession: session });
            saveSession(session); // Save updated stats

            // Handle auto-backoff
            chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (res) => {
                const settings = res[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
                if (settings.autoBackoff) {
                    // Use a modified backoff that respects our sequential monitoring
                    handleSequentialAutoBackoff(session);
                    return; // Skip normal scheduling
                } else {
                    // Schedule next with normal interval
                    scheduleNextMonitoringCapture(true);
                }
            });
        } else {
          // Clear analysis flag since session not active
          isAnalysisInProgress = false;
        }
      } else {
          // For non-rate-limit errors, make sure we don't stop the session if this is monitoring
          if (metadata.isMonitoring && backgroundState.currentSession) {
            log('API error during monitoring, but continuing session');
            updateBackgroundState({ status: { type: 'error', message: 'API error - continuing monitoring' } });
            // Schedule next capture after error
            scheduleNextMonitoringCapture(true);
          } else {
            updateBackgroundState({ status: { type: 'error', message: error.message || 'Analysis failed' } });
            // Clear analysis flag since this wasn't for monitoring or it failed
            isAnalysisInProgress = false;
          }
      }

      // Send error details for analysis completion message
      broadcastMessage({ action: 'analyzeComplete', data: { error, metadata } });
      log('VLM API request failed', { error, modelId });
    });
}

// Test API connection
async function testApiConnection(payload, apiKey) {
  try {
    const response = await makeApiRequest('https://openrouter.ai/api/v1/chat/completions', payload, apiKey);
    return response;
  } catch (error) {
    throw error;
  }
}

// Make API request to VLM provider
async function makeApiRequest(endpoint, payload, apiKey) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': chrome.runtime.getManifest().homepage_url,
        'X-Title': 'Screen Scoutr'
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw {
        status: response.status,
        statusText: response.statusText,
        message: errorData.error?.message || 'API request failed',
        data: errorData
      };
    }
    
    return await response.json();
  } catch (error) {
    if (error.status) {
      throw error;
    } else {
      throw {
        status: 0,
        statusText: 'Network Error',
        message: error.message || 'Network request failed',
        data: {}
      };
    }
  }
}

// Show notification
function showNotification(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: '/icons/default/128x128.png',
    title,
    message
  });
}

// Broadcast message ONLY to the popup
function broadcastMessage(message) {
  // Store the most recent message of each type in a local cache
  // This ensures it can be retrieved when the popup opens
  
  // Cache this message by action type
  if (message.action) {
    messageCache[message.action] = { 
      message,
      timestamp: Date.now()
    };
    
    // Expire cached messages after 5 minutes
    setTimeout(() => {
      if (messageCache[message.action] && 
          messageCache[message.action].timestamp < Date.now() - 300000) {
        delete messageCache[message.action];
      }
    }, 300000);
  }
  
  // Send the message to popup if open
  chrome.runtime.sendMessage(message).catch((error) => {
    if (error.message.includes('Receiving end does not exist')) {
      // Expected if popup is not open
      log('Popup not open, message cached for later delivery');
    } else {
      log('Error broadcasting message:', error, message);
    }
  });
}

// Get any cached messages when popup opens
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'getCachedMessages') {
    if (messageCache && Object.keys(messageCache).length > 0) {
      log('Providing cached messages to popup');
      sendResponse({ success: true, cache: messageCache });
    } else {
      sendResponse({ success: false });
    }
    return true;
  }
});

// Helper function for logging
function log(message, data) {
  const logEntry = {
    timestamp: new Date().toISOString(),
    message,
    data
  };
  
  // Check if debug mode is enabled
  chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
    const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
    
    if (settings.debugMode) {
      console.log(`[${new Date().toLocaleTimeString()}] ${message}`, data || '');
    }
    
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
  });
}

// --- Session Management --- //

function handleStartSession(initialSelectedArea, initialPrompt, options = {}) {
    log('Starting new session...', options);
    if (backgroundState.currentSession && backgroundState.currentSession.status !== 'completed') {
        log('Cannot start new session, one is already active or paused.');
        updateBackgroundState({ status: { type: 'warning', message: 'Session already running' } });
        return; // Don't start if one is running/paused
    }

    chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (result) => {
        const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
        const newSession = {
            id: generateId(),
            status: 'active',
            startTime: new Date().toISOString(),
            endTime: null,
            duration: 0,
            captureCount: 0,
            apiCallCount: 0,
            rateLimitCount: 0,
            lastCaptureTime: null,
            nextScheduledCapture: null, // Will be set after first capture
            
            // Store tab and window IDs from options
            tabId: options?.tabId,
            windowId: options?.windowId,
            
            // Store relevant settings for this session
            settings: {
                monitorInterval: settings.monitorInterval,
                vlmModel: settings.vlmModel,
                monitorPrompt: initialPrompt || '', // Use prompt from popup
                apiKey: settings.apiKey,
                enableNotifications: settings.enableNotifications,
                autoBackoff: settings.autoBackoff,
                conversationMode: options?.conversationMode || settings.conversationMode || false
            },
            selectedArea: initialSelectedArea || backgroundState.selectedArea, // Use area from popup or background state
            conversationHistory: [] // Initialize conversation history
        };
        
        // Log tab and window IDs for debugging
        if (options?.tabId && options?.windowId) {
            log('Session initialized with tab/window IDs:', { 
                tabId: options.tabId, 
                windowId: options.windowId 
            });
        } else {
            log('Warning: Session initialized without tab/window IDs');
        }

        updateBackgroundState({ 
            currentSession: newSession, 
            status: { type: 'active', message: 'Session started, capturing first image...' } 
        });
        saveSession(newSession); // Save to local storage
        
        // Start with analysis not in progress
        isAnalysisInProgress = false;
        
        // Trigger the first capture immediately
        startMonitoringAlarm();
    });
}

function handlePauseSession() {
    if (!backgroundState.currentSession || backgroundState.currentSession.status !== 'active') {
        log('No active session to pause.');
        return;
    }
    log('Pausing session...');
    stopMonitoringAlarm(); // Stop the next scheduled capture
    
    // Clear any analysis in progress
    isAnalysisInProgress = false;
    
    const updatedSession = {
        ...backgroundState.currentSession,
        status: 'paused',
        pauseTime: new Date().toISOString(),
        nextScheduledCapture: null // Clear scheduled time
    };
    
    updateBackgroundState({ currentSession: updatedSession, status: { type: 'idle', message: 'Session paused' } });
    saveSession(updatedSession);
    
    // Ensure popup is notified
    broadcastMessage({ action: 'sessionUpdate', session: updatedSession });
}

function handleResumeSessionLogic() {
    if (!backgroundState.currentSession || backgroundState.currentSession.status !== 'paused') {
        log('Background: No paused session to resume.');
        return { success: false, error: 'No paused session to resume' };
    }
    
    log('Background: Resuming session...');
    
    // Update the session status
    backgroundState.currentSession.status = 'active';
    backgroundState.currentSession.resumeTime = new Date().toISOString(); // Mark resume time
    
    // Update UI and save
    updateBackgroundState({ 
        currentSession: backgroundState.currentSession, 
        status: { type: 'active', message: 'Session resumed' } 
    });
    saveSession(backgroundState.currentSession);
    
    // Notify popup and other listeners
    broadcastMessage({ action: 'sessionUpdate', session: backgroundState.currentSession });
    
    // Start the monitoring loop again
    startMonitoringAlarm(); // This will clear any old alarms and start fresh
    
    return { success: true, session: backgroundState.currentSession };
}

function handleStopSession() {
    if (!backgroundState.currentSession || backgroundState.currentSession.status === 'completed') {
        log('No active or paused session to stop.');
        return;
    }
    log('Stopping session...');
    stopMonitoringAlarm(); // Stop the next scheduled capture
    
    // Clear any analysis in progress
    isAnalysisInProgress = false;
    
    const session = backgroundState.currentSession;
    const updatedSession = {
        ...session,
        status: 'completed',
        endTime: new Date().toISOString(),
        duration: calculateSessionDuration(session), // Calculate final duration
        nextScheduledCapture: null // Clear scheduled time
    };
    
    updateBackgroundState({ currentSession: null, status: { type: 'idle', message: 'Session completed' } });
    saveSession(updatedSession);
    
    // Ensure popup is notified
    broadcastMessage({ action: 'sessionUpdate', session: null });
}

function handleUpdateSessionSettings(settingsUpdate) {
    if (!backgroundState.currentSession) return;
    log('Updating session settings:', settingsUpdate);
    
    // Special case: Force the session to be active
    if (settingsUpdate.forceStatusActive === true) {
        log('CRITICAL: Force active session status received from popup');
        if (backgroundState.currentSession.status !== 'active') {
            backgroundState.currentSession.status = 'active';
            
            // Restart monitoring since session is being forced active
            if (!isAnalysisInProgress) {
                scheduleNextMonitoringCapture();
            }
        }
        
        // Ensure update reaches storage
        updateBackgroundState({ 
            currentSession: backgroundState.currentSession,
            status: { type: 'active', message: 'Monitoring reactivated' }
        });
        saveSession(backgroundState.currentSession);
        return;
    }
    
    // Handle conversation mode toggle
    if ('conversationMode' in settingsUpdate) {
        // If turning on conversation mode, initialize history if needed
        if (settingsUpdate.conversationMode && !backgroundState.currentSession.conversationHistory) {
            backgroundState.currentSession.conversationHistory = [];
        }
    }
    
    // Handle monitor prompt update
    if ('monitorPrompt' in settingsUpdate) {
        backgroundState.currentSession.settings.monitorPrompt = settingsUpdate.monitorPrompt;
    }
    
    // Regular settings update
    const updatedSession = {
        ...backgroundState.currentSession,
        settings: { ...backgroundState.currentSession.settings, ...settingsUpdate }
    };
    
    updateBackgroundState({ currentSession: updatedSession });
    saveSession(updatedSession);
    
    // If interval changed and session is active, reschedule next capture
    if ('monitorInterval' in settingsUpdate && 
        updatedSession.status === 'active' && 
        !isAnalysisInProgress &&
        updatedSession.nextScheduledCapture) {
        
        log('Monitor interval changed, rescheduling next capture with new interval.');
        // Use a special flag to indicate this is just an interval change reschedule
        scheduleNextMonitoringCapture(false);
    }
}

function calculateSessionDuration(session) {
    if (!session || !session.startTime) return 0;
    const endTime = session.endTime ? new Date(session.endTime) : new Date();
    const startTime = new Date(session.startTime);
    let totalDuration = Math.floor((endTime - startTime) / 1000);

    // Account for pause time if applicable (logic needs refinement if multiple pauses)
    if (session.pauseTime && session.resumeTime) {
        const pauseTime = new Date(session.pauseTime);
        const resumeTime = new Date(session.resumeTime);
        const pausedDuration = Math.floor((resumeTime - pauseTime) / 1000);
        totalDuration -= pausedDuration;
    }

    return Math.max(0, totalDuration); // Ensure duration is not negative
}

function captureForMonitoring() {
    if (!backgroundState.currentSession || backgroundState.currentSession.status !== 'active') {
        log('captureForMonitoring: Session not active.');
        isAnalysisInProgress = false; // Clear busy flag if called incorrectly
        return;
    }
    
    log('Automatic capture triggered for monitoring');
    const session = backgroundState.currentSession;
    
    // Use stored Tab ID and Window ID
    const targetTabId = session.tabId;
    const targetWindowId = session.windowId;
    
    // Check if we have valid tab and window IDs
    if (!targetTabId || !targetWindowId) {
        log('Warning: Session is missing target tabId or windowId. Attempting to use active tab as fallback.');
        
        // Try to use active tab as fallback
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || tabs.length === 0) {
                log('Error: Failed to find any active tab as fallback. Stopping session.');
                updateBackgroundState({ status: { type: 'error', message: 'No active tab found. Session stopped.' }});
                handleStopSession(); // Stop the session permanently
                isAnalysisInProgress = false;
                return;
            }
            
            const activeTab = tabs[0];
            
            // Update the session with the active tab's information
            session.tabId = activeTab.id;
            session.windowId = activeTab.windowId;
            
            log(`Using active tab as fallback. Tab ID: ${activeTab.id}, Window ID: ${activeTab.windowId}`);
            
            // Save the updated session
            updateBackgroundState({ currentSession: session });
            saveSession(session);
            
            // Now retry the capture with the updated tab info
            setTimeout(() => captureForMonitoring(), 100);
        });
        return;
    }
    
    log(`Attempting capture on Tab ID: ${targetTabId}, Window ID: ${targetWindowId}`);
    
    // Update session stats BEFORE capture
    session.captureCount = (session.captureCount || 0) + 1;
    session.lastCaptureTime = new Date().toISOString();
    
    // Update background state with the updated session
    updateBackgroundState({ currentSession: session });
    saveSession(session); // Save immediately so data isn't lost
    
    // Broadcast the updated session to popup
    broadcastMessage({
      action: 'sessionUpdate',
      session: session
    });
    
    // Prepare monitoring session info for analysis
    const monitorSessionInfo = {
        sessionId: session.id,
        prompt: session.settings.monitorPrompt || 'Analyze this image',
        conversationMode: session.settings.conversationMode || false
    };
    
    // FIXED: Always prioritize the session's selectedArea - this is what user initially selected
    const areaToCapture = session.selectedArea;
    
    if (!areaToCapture) {
        log('Warning: No selected area found in session for monitoring. Will use full viewport.');
    } else {
        log('Using selected area from session for monitoring:', areaToCapture);
    }
    
    // Use targetWindowId for captureVisibleTab
    chrome.tabs.captureVisibleTab(targetWindowId, { format: 'jpeg', quality: 95 }, (dataUrl) => {
        if (chrome.runtime.lastError) {
            log(`Error capturing window ${targetWindowId} for tab ${targetTabId}`, chrome.runtime.lastError);
            
            // Handle Capture Error
            if (chrome.runtime.lastError.message.includes("No tab with id") ||
                chrome.runtime.lastError.message.includes("No window with id")) {
                log(`Target tab ${targetTabId} or window ${targetWindowId} not found. Trying to recover...`);
                
                // Try to use active tab as fallback
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (!tabs || tabs.length === 0) {
                        log('Recovery failed: No active tab found. Stopping session.');
                        updateBackgroundState({ status: { type: 'error', message: 'Target window/tab closed. Session stopped.' }});
                        handleStopSession(); // Stop the session permanently
                        isAnalysisInProgress = false;
                        return;
                    }
                    
                    const activeTab = tabs[0];
                    
                    // Update session with new tab info
                    session.tabId = activeTab.id;
                    session.windowId = activeTab.windowId;
                    updateBackgroundState({ 
                        currentSession: session,
                        status: { type: 'warning', message: 'Tab changed, recovered using current tab' }
                    });
                    saveSession(session);
                    
                    log('Recovered session with new tab/window IDs, scheduling next capture');
                    // Schedule next capture attempt
                    scheduleNextMonitoringCapture(true, 10); // Try again in 10 seconds
                });
            } else {
                // Other capture error (e.g., page loading, protected page)
                updateBackgroundState({ status: { type: 'warning', message: 'Capture failed, retrying next interval.' }});
                // Schedule next attempt even on capture error
                scheduleNextMonitoringCapture(true);
            }
            isAnalysisInProgress = false; // Clear busy flag
            return;
        }
        
        // Proceed with cropping/analysis if capture succeeded
        log(`Successfully captured window ${targetWindowId}. Proceeding with processing for tab ${targetTabId}.`);
        
        // Check if the tab still exists
        chrome.tabs.get(targetTabId, (tabDetails) => {
            if(chrome.runtime.lastError || !tabDetails) {
                log(`Tab ${targetTabId} disappeared after capture. Skipping analysis.`);
                scheduleNextMonitoringCapture(true); // Schedule next
                isAnalysisInProgress = false;
                return;
            }
            
            if (areaToCapture) {
                log('Monitor: Processing selected area', areaToCapture);
                
                // FIXED: Ensure we normalize area properties for consistency
                const normalizedArea = {
                    left: areaToCapture.left || areaToCapture.x || 0,
                    top: areaToCapture.top || areaToCapture.y || 0,
                    width: areaToCapture.width || areaToCapture.w || 0,
                    height: areaToCapture.height || areaToCapture.h || 0,
                    devicePixelRatio: areaToCapture.devicePixelRatio || window.devicePixelRatio || 1
                };
                
                // Use cropImage function first
                cropImage(dataUrl, normalizedArea)
                    .then(croppedDataUrl => {
                        log('Image cropped successfully in background');
                        handleCapturedImage({ 
                            dataUrl: croppedDataUrl, 
                            timestamp: new Date().toISOString(),
                            // Add metadata about the crop to help with debugging
                            cropInfo: {
                                source: 'background',
                                area: normalizedArea
                            }
                        }, normalizedArea, { autoAnalyze: true, monitorSession: monitorSessionInfo });
                    })
                    .catch(cropError => {
                        log('Background cropping failed, trying content script method', cropError);
                        
                        // Try the content script method as fallback
                        cropImageInContentScript(targetTabId, dataUrl, normalizedArea)
                            .then(croppedDataUrl => {
                                log('Image cropped successfully in content script');
                                handleCapturedImage({ 
                                    dataUrl: croppedDataUrl, 
                                    timestamp: new Date().toISOString(),
                                    cropInfo: {
                                        source: 'content-script',
                                        area: normalizedArea
                                    }
                                }, normalizedArea, { autoAnalyze: true, monitorSession: monitorSessionInfo });
                            })
                            .catch(contentError => {
                                log('All cropping methods failed, using full viewport as last resort', contentError);
                                // Use the full capture as fallback, but flag it
                                handleCapturedImage({ 
                                    dataUrl, 
                                    timestamp: new Date().toISOString(), 
                                    cropFailed: true,
                                    cropInfo: {
                                        error: 'All cropping methods failed',
                                        attempted: true
                                    }
                                }, null, { autoAnalyze: true, monitorSession: monitorSessionInfo });
                            });
                    });
            } else {
                log('Monitor: No area selected, processing full viewport');
                handleCapturedImage({ 
                    dataUrl, 
                    timestamp: new Date().toISOString(),
                    cropInfo: {
                        message: 'No area selected, using full viewport'
                    }
                }, null, { autoAnalyze: true, monitorSession: monitorSessionInfo });
            }
        });
    });
}

function handleSequentialAutoBackoff(session) {
    if (!session || session.status !== 'active') return;

    // Clear any existing alarms
    stopMonitoringAlarm();
    
    // Calculate backoff time based on number of rate limits hit
    const backoffTimeSeconds = Math.min(300, Math.pow(2, session.rateLimitCount || 0) + 5);
    log(`Rate limit auto-backoff: Pausing monitoring for ${backoffTimeSeconds} seconds.`);
    updateBackgroundState({ status: { type: 'warning', message: `Rate limit: Backing off ${backoffTimeSeconds}s` } });

    // Clear the busy flag
    isAnalysisInProgress = false;
    
    // Update the session with the backoff time
    session.nextScheduledCapture = Date.now() + (backoffTimeSeconds * 1000);
    updateBackgroundState({ currentSession: session });
    saveSession(session);
    
    // Broadcast update so popup shows backoff time
    broadcastMessage({ action: 'sessionUpdate', session: session });

    // Set a one-time alarm to resume monitoring
    chrome.alarms.create('resumeMonitoring', { delayInMinutes: backoffTimeSeconds / 60 });
}

// New function to schedule the next capture using a one-time alarm
function scheduleNextMonitoringCapture(afterError = false, delaySecondsOverride = null) {
    // Clear the busy flag FIRST, regardless of whether session is active
    isAnalysisInProgress = false;
    log('Analysis complete. Busy flag cleared.');

    if (!backgroundState.currentSession || backgroundState.currentSession.status !== 'active') {
        log('scheduleNextMonitoringCapture: Session is not active, not scheduling next capture.');
        stopMonitoringAlarm(); // Ensure alarm is cleared
        return;
    }

    // Get interval from session settings or use override
    const intervalSeconds = delaySecondsOverride !== null ? 
        delaySecondsOverride : 
        (backgroundState.currentSession.settings?.monitorInterval || DEFAULT_SETTINGS.monitorInterval);
    
    // Convert to minutes for the alarm API (minimum is 0.1 minute or 6 seconds)
    const delayMinutes = Math.max(0.1, intervalSeconds / 60); 
    
    // Calculate the actual time of the next capture
    const nextCaptureTime = Date.now() + (intervalSeconds * 1000);

    log(`Scheduling next capture in ${intervalSeconds} seconds (alarm delay: ${delayMinutes.toFixed(2)} mins).`);

    // Update session state with next scheduled time
    backgroundState.currentSession.nextScheduledCapture = nextCaptureTime;
    updateBackgroundState({
        currentSession: backgroundState.currentSession,
        status: { type: 'active', message: `Waiting for next capture (${intervalSeconds}s)...` }
    });
    saveSession(backgroundState.currentSession); // Save the next scheduled time

    // Clear any previous 'nextCapture' alarm before setting a new one
    chrome.alarms.clear(NEXT_CAPTURE_ALARM_NAME, (wasCleared) => {
        log(`Previous '${NEXT_CAPTURE_ALARM_NAME}' alarm cleared: ${wasCleared}`);

        // Create a new one-time alarm
        chrome.alarms.create(NEXT_CAPTURE_ALARM_NAME, {
            delayInMinutes: delayMinutes
        });
        log(`'${NEXT_CAPTURE_ALARM_NAME}' alarm created.`);

        // Broadcast the update so the popup shows the countdown
        broadcastMessage({ action: 'sessionUpdate', session: backgroundState.currentSession });
    });
}

// --- Storage Functions --- //

function saveSession(session) {
  chrome.storage.local.get([STORAGE_KEYS.SESSIONS], (result) => {
    let sessions = result[STORAGE_KEYS.SESSIONS] || [];
    const index = sessions.findIndex(s => s.id === session.id);
    if (index !== -1) { sessions[index] = session; }
    else { sessions.push(session); }
    sessions.sort((a, b) => new Date(b.startTime) - new Date(a.startTime));
    chrome.storage.local.set({ [STORAGE_KEYS.SESSIONS]: sessions });
    log(`Session ${session.id} saved`);
    // Optionally broadcast session update to filters in popup
    broadcastMessage({ action: 'sessionListUpdated' });
  });
}

function saveResponse(response) {
  chrome.storage.local.get([STORAGE_KEYS.RESPONSES], (result) => {
    let responses = result[STORAGE_KEYS.RESPONSES] || [];
    responses.push(response);
    responses.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    if (responses.length > 1000) { responses = responses.slice(0, 1000); }
    chrome.storage.local.set({ [STORAGE_KEYS.RESPONSES]: responses });
    log(`Response ${response.id} saved`);
    // Optionally broadcast history update
    broadcastMessage({ action: 'historyUpdated' });
  });
}

function generateId() {
  return 'id_' + Math.random().toString(36).substr(2, 9);
}

// --- Original Extension Compatibility Code --- //

// ... (Defaults, storage sync get/set, setIcon - mostly unchanged) ...
// Make sure the original `chrome.storage.sync.get` doesn't overwrite our settings
// It's better to manage settings consistently using STORAGE_KEYS.SETTINGS

function inject(tab) { // Original inject function
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, {message: 'init'}, (res) => {
    if (chrome.runtime.lastError) {
        log('Inject: Error sending init message, maybe script not ready?', chrome.runtime.lastError);
        // Fallback to executing scripts if init fails (might happen on first click)
        executeOriginalScripts(tab.id);
        return;
    }
    if (res) {
      log('Inject: Init successful, clearing timeout');
      clearTimeout(timeout);
    } else {
        // If init fails, scripts might not be there yet
        log('Inject: Init response not received, executing scripts');
        executeOriginalScripts(tab.id);
    }
  });

  // Timeout to ensure scripts are injected if init message fails
  var timeout = setTimeout(() => {
    log('Inject: Timeout reached, executing scripts');
    executeOriginalScripts(tab.id);
  }, 200); // Increased timeout slightly
}

function executeOriginalScripts(tabId) {
    log(`Executing original scripts for tab ${tabId}`);
    chrome.scripting.insertCSS({files: ['vendor/jquery.Jcrop.min.css', 'content/index.css'], target: {tabId: tabId}})
        .catch(e => log('Error injecting original CSS:', e));
    chrome.scripting.executeScript({files: ['vendor/jquery.min.js'], target: {tabId: tabId}})
        .then(() => chrome.scripting.executeScript({files: ['vendor/jquery.Jcrop.min.js'], target: {tabId: tabId}}))
        .then(() => chrome.scripting.executeScript({files: ['content/crop.js'], target: {tabId: tabId}}))
        .then(() => chrome.scripting.executeScript({files: ['content/index.js'], target: {tabId: tabId}}))
        .then(() => {
            log('Original scripts executed, sending init message again');
            // Send init message after scripts are definitely injected
            setTimeout(() => {
              chrome.tabs.sendMessage(tabId, {message: 'init'}, (res) => {
                  if (chrome.runtime.lastError) {
                      log('Error sending init after script execution:', chrome.runtime.lastError);
                  }
              });
            }, 100);
        })
        .catch(e => log('Error executing original scripts:', e));
}

// Original action onClicked and commands listeners remain the same
chrome.action.onClicked.addListener((tab) => {
  log('Original action onClicked');
  inject(tab);
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'take-screenshot') {
    log('Original command take-screenshot received');
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (tabs[0]) {
        inject(tabs[0]);
      }
    });
  }
});
