// Constants
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

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
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
      captureViewport(sender.tab);
      sendResponse({ success: true });
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
      captureViewportArea(message.area, message.tab);
      sendResponse({ success: true });
      break;

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
      handleStartSession(message.selectedArea, message.prompt);
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

// Handle alarm events
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'monitoring') {
    log('Monitoring alarm triggered');
    if (backgroundState.currentSession && backgroundState.currentSession.status === 'active') {
      captureForMonitoring();
    } else {
      log('Session not active, clearing monitoring alarm');
      stopMonitoringAlarm(); // Stop alarm if session ended unexpectedly
    }
  }
});

// Capture viewport
function captureViewport(tab) {
  updateBackgroundState({ status: { type: 'processing', message: 'Capturing viewport...' } });
  chrome.tabs.captureVisibleTab(tab?.windowId, { format: 'jpeg', quality: 70 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      log('Error capturing viewport', chrome.runtime.lastError);
      updateBackgroundState({ status: { type: 'error', message: 'Failed to capture viewport' } });
      return;
    }
    const capturedData = { dataUrl, timestamp: new Date().toISOString() };
    updateBackgroundState({ capturedImage: capturedData, selectedArea: null, status: { type: 'active', message: 'Viewport captured' } });
    // broadcastMessage handled by updateBackgroundState
    log('Viewport captured');
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
  updateBackgroundState({ selectedArea: data, status: { type: 'active', message: 'Area selected' } });
  
  // Immediately capture the selected area, even if popup is closed
  log('Auto-capturing the selected area after selection');
  captureViewportArea(data, tab);
}

// Capture viewport area based on selection
function captureViewportArea(area, tab) {
  if (!area) {
    log('Attempted to capture area, but no area data provided');
    updateBackgroundState({ status: { type: 'warning', message: 'No area selected' } });
    return;
  }
  
  log('captureViewportArea called with area:', area);
  updateBackgroundState({ status: { type: 'processing', message: 'Capturing area...' } });
  
  // Ensure we have tab info
  if (!tab || !tab.windowId) {
    log('Missing tab info for captureViewportArea, querying active tab');
    chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
      if (!tabs || tabs.length === 0) {
        log('No active tab found for captureViewportArea');
        updateBackgroundState({ status: { type: 'error', message: 'Failed to find active tab for capture' } });
        return;
      }
      // Recursive call with proper tab
      log('Found active tab, retrying captureViewportArea');
      captureViewportArea(area, tabs[0]);
    });
    return;
  }
  
  log('Capturing viewport from tab:', tab.id, 'window:', tab.windowId);
  // Ensure we're capturing from the proper window
  chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 95 }, (dataUrl) => {
    if (chrome.runtime.lastError) {
      log('Error capturing viewport for area crop', chrome.runtime.lastError);
      updateBackgroundState({ status: { type: 'error', message: 'Failed to capture for crop' } });
      return;
    }

    log('Successfully captured viewport, proceeding to crop', { windowId: tab.windowId });
    
    // Try to crop the image in the background first
    cropImage(dataUrl, area)
      .then(croppedDataUrl => {
        log('Image cropped successfully in background, size:', croppedDataUrl.length);
        const capturedData = { dataUrl: croppedDataUrl, timestamp: new Date().toISOString() };
        handleCapturedImage(capturedData, area, 'background');
      })
      .catch(error => {
        log('Error cropping image in background, trying content script method', error);
        
        // Try the content script method as a better fallback
        cropImageInContentScript(tab.id, dataUrl, area)
          .then(croppedDataUrl => {
            log('Image cropped successfully in content script, size:', croppedDataUrl.length);
            const capturedData = { dataUrl: croppedDataUrl, timestamp: new Date().toISOString() };
            handleCapturedImage(capturedData, area, 'content script');
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
          });
      });
  });
}

// Helper function to handle captured image processing
function handleCapturedImage(capturedData, area, source = 'background') {
  // Update background state with the captured image
  updateBackgroundState({ 
    capturedImage: capturedData, 
    status: { type: 'active', message: `Area captured${source !== 'background' ? ` (${source})` : ''}` }
  });
  
  // Explicitly broadcast the capture complete message to ensure popup gets it
  try {
    log(`Broadcasting captureComplete message (source: ${source})`);
    broadcastMessage({ 
      action: 'captureComplete', 
      data: capturedData,
      analyze: false
    });
    
    // Send an extra direct message to ensure the popup receives it
    chrome.runtime.sendMessage({ 
      action: 'captureComplete', 
      data: capturedData,
      analyze: false
    }).catch(err => {
      // This might fail if popup is not open, which is fine
      log(`Direct captureComplete message failed (normal if popup closed): ${err.message}`);
    });
    
    log('Area captured and cropped successfully, image broadcast to popup');
  } catch (error) {
    log('Error broadcasting capture complete:', error);
  }

  // If part of an active session, proceed to analysis
  if (backgroundState.currentSession?.status === 'active') {
    const session = backgroundState.currentSession;
    session.captureCount = (session.captureCount || 0) + 1;
    session.lastCaptureTime = new Date().toISOString();
    updateBackgroundState({ currentSession: { ...session } }); // Trigger UI update
    saveSession(session); // Save updated stats

    if (session.settings?.prompt) {
      analyzeImage(
        { model: session.settings.vlmModel, prompt: session.settings.prompt, imageDataUrl: capturedData.dataUrl },
        session.settings.apiKey,
        { 
          prompt: session.settings.prompt, 
          imageSize: { width: area.width, height: area.height, total: area.width * area.height }, 
          timestamp: capturedData.timestamp, 
          sessionId: session.id 
        }
      );
    }
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
  return new Promise((resolve, reject) => {
    log('Starting to crop image', { area });
    const img = new Image();
    
    img.onload = function() {
      try {
        log('Image loaded for cropping, dimensions:', { width: img.width, height: img.height });
        
        // Create canvas - in MV3 we need to be careful about canvas creation in background
        const canvas = document.createElement('canvas');
        
        // Use 2d context with alpha: false for better performance
        const ctx = canvas.getContext('2d', { alpha: false });
        if (!ctx) {
          throw new Error("Failed to get canvas context");
        }
        
        // Scale based on device pixel ratio
        const scaleFactor = area.devicePixelRatio || 1;
        log('Using scale factor:', scaleFactor);
        
        // Validate area coordinates against image dimensions
        const maxWidth = img.width / scaleFactor;
        const maxHeight = img.height / scaleFactor;
        
        // Ensure area is within bounds
        if (area.left < 0 || area.top < 0 || area.left + area.width > maxWidth || area.top + area.height > maxHeight) {
          log('Warning: Selection area extends beyond image bounds, adjusting...', {
            area,
            imageDimensions: { width: maxWidth, height: maxHeight }
          });
          
          // Adjust area to fit within bounds
          const adjustedArea = {
            left: Math.max(0, area.left),
            top: Math.max(0, area.top),
            width: Math.min(area.width, maxWidth - Math.max(0, area.left)),
            height: Math.min(area.height, maxHeight - Math.max(0, area.top)),
            devicePixelRatio: area.devicePixelRatio
          };
          
          area = adjustedArea;
          log('Adjusted area to:', area);
        }
        
        // Set canvas dimensions - make sure they're integers to avoid issues
        const canvasWidth = Math.round(area.width * scaleFactor);
        const canvasHeight = Math.round(area.height * scaleFactor);
        canvas.width = canvasWidth;
        canvas.height = canvasHeight;
        
        if (canvasWidth <= 0 || canvasHeight <= 0) {
          throw new Error("Invalid canvas dimensions: width or height is zero or negative");
        }
        
        log('Canvas created with dimensions:', { width: canvas.width, height: canvas.height });
        
        // Draw cropped image
        try {
          // Clear canvas first
          ctx.fillStyle = "#FFFFFF";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          
          // Calculate source coordinates - ensure they're integers to avoid blurry images
          const sx = Math.round(area.left * scaleFactor);
          const sy = Math.round(area.top * scaleFactor);
          const sWidth = Math.round(area.width * scaleFactor);
          const sHeight = Math.round(area.height * scaleFactor);
          
          log('Drawing image with params:', {
            sx, sy, sWidth, sHeight,
            dx: 0, dy: 0, 
            dWidth: canvas.width, dHeight: canvas.height
          });
          
          // Draw the image to canvas
          ctx.drawImage(
            img,
            sx, sy, sWidth, sHeight,
            0, 0, canvas.width, canvas.height
          );
          
          // Get data URL - use JPEG for smaller size
          let croppedDataUrl;
          try {
            croppedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
            log('Image successfully cropped, data URL length:', croppedDataUrl.length);
            
            // Check if the data URL is valid by checking its length and beginning
            if (!croppedDataUrl || croppedDataUrl.length < 22 || !croppedDataUrl.startsWith('data:image/jpeg')) {
              throw new Error('Generated data URL is invalid');
            }
            
            resolve(croppedDataUrl);
          } catch (dataUrlError) {
            log('Error generating data URL:', dataUrlError);
            reject(new Error('Failed to convert canvas to data URL'));
          }
        } catch (drawError) {
          log('Error drawing image to canvas:', drawError, {
            imgDimensions: { width: img.width, height: img.height },
            area: area,
            scaledArea: {
              x: Math.round(area.left * scaleFactor),
              y: Math.round(area.top * scaleFactor),
              width: Math.round(area.width * scaleFactor),
              height: Math.round(area.height * scaleFactor)
            }
          });
          reject(new Error('Failed to draw image to canvas: ' + drawError.message));
        }
      } catch (error) {
        log('Error during canvas setup:', error);
        reject(new Error('Canvas setup failed: ' + error.message));
      }
    };
    
    img.onerror = function(e) {
      log('Failed to load image for cropping:', e);
      reject(new Error('Failed to load image'));
    };
    
    // Set crossOrigin to anonymous to handle CORS issues
    img.crossOrigin = "anonymous";
    
    try {
      img.src = dataUrl;
      
      // If the image is already cached, the onload event might not fire
      // This is a fallback to handle that case
      if (img.complete) {
        log('Image already loaded (cached), triggering onload handler');
        img.onload();
      }
    } catch (error) {
      log('Error setting image source:', error);
      reject(new Error('Failed to set image source: ' + error.message));
    }
  });
}

// Analyze image with VLM API
function analyzeImage(payload, apiKey, metadata) {
  updateBackgroundState({ status: { type: 'processing', message: 'Sending to VLM API...' } });

  const modelId = payload.model;
  const prompt = payload.prompt;
  const imageDataUrl = payload.imageDataUrl;
  const imageSize = metadata.imageSize || { width:0, height:0, total: 0 }; // Get size from metadata

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
      updateBackgroundState({ currentSession: { ...session } });
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

      updateBackgroundState({ status: { type: 'active', message: 'Analysis complete' } });
      broadcastMessage({ action: 'analyzeComplete', data: { response: resultData } }); // Send structured response to popup
      log('VLM API request successful', { modelId });

      // If enabled, send notification
      chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (res) => {
          const settings = res[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
          if (settings.enableNotifications) {
              showNotification('AI Screen Watcher', `Analysis complete: ${responseText.substring(0, 50)}...`);
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
            updateBackgroundState({ currentSession: { ...session } });
            saveSession(session); // Save updated stats

            // Handle auto-backoff
            chrome.storage.sync.get([STORAGE_KEYS.SETTINGS], (res) => {
                const settings = res[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
                if (settings.autoBackoff) {
                    handleAutoBackoff(session);
                }
            });
        }
      } else {
          updateBackgroundState({ status: { type: 'error', message: error.message || 'Analysis failed' } });
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
        'X-Title': 'AI Screen Watcher'
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

function handleStartSession(initialSelectedArea, initialPrompt) {
    log('Starting new session...');
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
            // Store relevant settings for this session
            settings: {
                monitorInterval: settings.monitorInterval,
                vlmModel: settings.vlmModel,
                prompt: initialPrompt || '', // Use prompt from popup
                apiKey: settings.apiKey,
                enableNotifications: settings.enableNotifications,
                autoBackoff: settings.autoBackoff
            },
            selectedArea: initialSelectedArea || backgroundState.selectedArea // Use area from popup or background state
        };

        updateBackgroundState({ currentSession: newSession, status: { type: 'active', message: 'Session started' } });
        saveSession(newSession); // Save to local storage
        startMonitoringAlarm(); // Start the interval timer
    });
}

function handlePauseSession() {
    if (!backgroundState.currentSession || backgroundState.currentSession.status !== 'active') {
        log('No active session to pause.');
        return;
    }
    log('Pausing session...');
    stopMonitoringAlarm(); // Stop the interval timer
    const updatedSession = {
        ...backgroundState.currentSession,
        status: 'paused',
        pauseTime: new Date().toISOString()
    };
    updateBackgroundState({ currentSession: updatedSession, status: { type: 'idle', message: 'Session paused' } });
    saveSession(updatedSession);
}

function handleResumeSession() { // Potentially useful if pause/resume UI exists
    if (!backgroundState.currentSession || backgroundState.currentSession.status !== 'paused') {
        log('No paused session to resume.');
        return;
    }
    log('Resuming session...');
    const updatedSession = {
        ...backgroundState.currentSession,
        status: 'active',
        resumeTime: new Date().toISOString(),
        // Reset pauseTime to avoid incorrect duration calculation on next pause
        pauseTime: null
    };
    updateBackgroundState({ currentSession: updatedSession, status: { type: 'active', message: 'Session resumed' } });
    saveSession(updatedSession);
    startMonitoringAlarm(); // Restart the interval timer
}

function handleStopSession() {
    if (!backgroundState.currentSession || backgroundState.currentSession.status === 'completed') {
        log('No active or paused session to stop.');
        return;
    }
    log('Stopping session...');
    stopMonitoringAlarm(); // Stop the interval timer
    const session = backgroundState.currentSession;
    const updatedSession = {
        ...session,
        status: 'completed',
        endTime: new Date().toISOString(),
        duration: calculateSessionDuration(session) // Calculate final duration
    };
    updateBackgroundState({ currentSession: null, status: { type: 'idle', message: 'Session completed' } });
    saveSession(updatedSession);
}

function handleUpdateSessionSettings(settingsUpdate) {
    if (!backgroundState.currentSession) return;
    log('Updating session settings:', settingsUpdate);
    const updatedSession = {
        ...backgroundState.currentSession,
        settings: { ...backgroundState.currentSession.settings, ...settingsUpdate }
    };
    updateBackgroundState({ currentSession: updatedSession });
    saveSession(updatedSession);

    // If interval changed and session is active, restart alarm
    if ('monitorInterval' in settingsUpdate && updatedSession.status === 'active') {
        stopMonitoringAlarm();
        startMonitoringAlarm();
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

function startMonitoringAlarm() {
    if (!backgroundState.currentSession) return;
    const intervalSeconds = Math.max(10, backgroundState.currentSession.settings.monitorInterval);
    chrome.alarms.create('monitoring', {
        // delayInMinutes: 0.1, // Start almost immediately for testing
        periodInMinutes: intervalSeconds / 60
    });
    log(`Monitoring alarm created/updated with interval: ${intervalSeconds} seconds`);
}

function stopMonitoringAlarm() {
    chrome.alarms.clear('monitoring');
    log('Monitoring alarm cleared');
}

function captureForMonitoring() {
    if (!backgroundState.currentSession) return;
    log('Automatic capture triggered by monitoring alarm');
    const session = backgroundState.currentSession;

    // Find an active tab to capture from (best effort)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const targetTab = tabs[0];
        if (!targetTab) {
            log('Monitor capture: No active tab found.');
            // Optionally try capturing any window's active tab
            // Or notify the user the monitor couldn't run
            return;
        }

        if (session.selectedArea) {
            log('Monitor: Capturing selected area');
            captureViewportArea(session.selectedArea, targetTab);
        } else {
            log('Monitor: Capturing viewport');
            captureViewport(targetTab);
        }
        // Analysis will be triggered by capture complete if needed
    });
}

function handleAutoBackoff(session) {
    if (!session || session.status !== 'active') return;

    stopMonitoringAlarm(); // Stop regular checks
    const backoffTimeSeconds = Math.min(300, Math.pow(2, session.rateLimitCount || 0) + 5);
    log(`Rate limit auto-backoff: Pausing monitoring for ${backoffTimeSeconds} seconds.`);
    updateBackgroundState({ status: { type: 'warning', message: `Rate limit: Backing off ${backoffTimeSeconds}s` } });

    // Set a one-time alarm to resume monitoring
    chrome.alarms.create('resumeMonitoring', { delayInMinutes: backoffTimeSeconds / 60 });

    // Listener specifically for resuming after backoff
    const resumeListener = (alarm) => {
        if (alarm.name === 'resumeMonitoring') {
            log('Resuming monitoring after backoff.');
            // Check if the session is still supposed to be active
            if (backgroundState.currentSession?.id === session.id && backgroundState.currentSession?.status === 'active') {
                 updateBackgroundState({ status: { type: 'active', message: 'Monitoring resumed' } });
                 startMonitoringAlarm(); // Restart periodic alarm
            } else {
                 log('Session changed/stopped during backoff, not resuming alarm.');
            }
            chrome.alarms.onAlarm.removeListener(resumeListener); // Clean up this listener
        }
    };
    chrome.alarms.onAlarm.addListener(resumeListener);
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
