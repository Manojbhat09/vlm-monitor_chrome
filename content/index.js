var jcrop, selection

var overlay = ((active) => (state) => {
  active = typeof state === 'boolean' ? state : state === null ? active : !active
  $('.jcrop-holder')[active ? 'show' : 'hide']()
  chrome.runtime.sendMessage({message: 'active', active})
})(false)

var image = (done) => {
  var image = new Image()
  image.id = 'fake-image'
  image.src = chrome.runtime.getURL('/content/pixel.png')
  image.onload = () => {
    $('body').append(image)
    done()
  }
}

var init = (done) => {
  $('#fake-image').Jcrop({
    bgColor: 'none',
    onSelect: (e) => {
      selection = e
      capture()
    },
    onChange: (e) => {
      selection = e
    },
    onRelease: (e) => {
      setTimeout(() => {
        selection = null
      }, 100)
    }
  }, function ready () {
    jcrop = this

    $('.jcrop-hline, .jcrop-vline').css({
      backgroundImage: `url(${chrome.runtime.getURL('/vendor/Jcrop.gif')})`
    })

    if (selection) {
      jcrop.setSelect([
        selection.x, selection.y,
        selection.x2, selection.y2
      ])
    }

    done && done()
  })
}

var capture = (force) => {
  chrome.storage.sync.get((config) => {
    if (selection && (config.method === 'crop' || (config.method === 'wait' && force))) {
      jcrop.release()
      setTimeout(() => {
        var _selection = selection
        chrome.runtime.sendMessage({
          message: 'capture', format: config.format, quality: config.quality
        }, (res) => {
          overlay(false)
          crop(res.image, _selection, devicePixelRatio, config.scaling, config.format, (image) => {
            save(image, config.format, config.save, config.clipboard, config.dialog)
            selection = null
          })
        })
      }, 50)
    }
    else if (config.method === 'view') {
      chrome.runtime.sendMessage({
        message: 'capture', format: config.format, quality: config.quality
      }, (res) => {
        overlay(false)
        if (devicePixelRatio !== 1 && !config.scaling) {
          var area = {x: 0, y: 0, w: innerWidth, h: innerHeight}
          crop(res.image, area, devicePixelRatio, config.scaling, config.format, (image) => {
            save(image, config.format, config.save, config.clipboard, config.dialog)
          })
        }
        else {
          save(res.image, config.format, config.save, config.clipboard, config.dialog)
        }
      })
    }
    else if (config.method === 'page') {
      var container = ((html = document.querySelector('html')) => (
        html.scrollTop = 1,
        html.scrollTop ? (html.scrollTop = 0, html) : document.querySelector('body')
      ))()
      container.scrollTop = 0
      document.querySelector('html').style.overflow = 'hidden'
      document.querySelector('body').style.overflow = 'hidden'
      setTimeout(() => {
        var images = []
        var count = 0
        ;(function scroll (done) {
          chrome.runtime.sendMessage({
            message: 'capture', format: config.format, quality: config.quality
          }, (res) => {
            var height = innerHeight
            if (count * innerHeight > container.scrollTop) {
              height = container.scrollTop - (count - 1) * innerHeight
            }
            images.push({height, offset: container.scrollTop, image: res.image})

            if (
              (count * innerHeight === container.scrollTop &&
              (count - 1) * innerHeight === container.scrollTop) ||
              count * innerHeight > container.scrollTop
              ) {
              done()
              return
            }

            count += 1
            container.scrollTop = count * innerHeight
            setTimeout(() => {
              if (count * innerHeight !== container.scrollTop) {
                container.scrollTop = count * innerHeight
              }
              scroll(done)
            }, config.delay)
          })
        })(() => {
          overlay(false)
          var area = {x: 0, y: 0, w: innerWidth, h: images.reduce((all, {height}) => all += height, 0)}
          crop(images, area, devicePixelRatio, config.scaling, config.format, (image) => {
            document.querySelector('html').style.overflow = ''
            document.querySelector('body').style.overflow = ''
            save(image, config.format, config.save, config.clipboard, config.dialog)
          })
        })
      }, config.delay)
    }
  })
}

var filename = (format) => {
  var pad = (n) => (n = n + '', n.length >= 2 ? n : `0${n}`)
  var ext = (format) => format === 'jpeg' ? 'jpg' : format === 'png' ? 'png' : 'png'
  var timestamp = (now) =>
    [pad(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate())].join('-')
    + ' - ' +
    [pad(now.getHours()), pad(now.getMinutes()), pad(now.getSeconds())].join('-')
  return `Screenshot Capture - ${timestamp(new Date())}.${ext(format)}`
}

var save = (image, format, save, clipboard, dialog) => {
  if (save.includes('file')) {
    var link = document.createElement('a')
    link.download = filename(format)
    link.href = image
    link.click()
  }
  if (save.includes('clipboard')) {
    if (clipboard === 'url') {
      navigator.clipboard.writeText(image).then(() => {
        if (dialog) {
          alert([
            'Screenshot Capture:',
            'Data URL String',
            'Saved to Clipboard!'
          ].join('\n'))
        }
      })
    }
    else if (clipboard === 'binary') {
      var [header, base64] = image.split(',')
      var [_, type] = /data:(.*);base64/.exec(header)
      var binary = atob(base64)
      var array = Array.from({length: binary.length})
        .map((_, index) => binary.charCodeAt(index))
      navigator.clipboard.write([
        new ClipboardItem({
          // jpeg is not supported on write, though the encoding is preserved
          'image/png': new Blob([new Uint8Array(array)], {type: 'image/png'})
        })
      ]).then(() => {
        if (dialog) {
          alert([
            'Screenshot Capture:',
            'Binary Image',
            'Saved to Clipboard!'
          ].join('\n'))
        }
      })
    }
  }
}

window.addEventListener('resize', ((timeout) => () => {
  clearTimeout(timeout)
  timeout = setTimeout(() => {
    jcrop.destroy()
    init(() => overlay(null))
  }, 100)
})())

chrome.runtime.onMessage.addListener((req, sender, res) => {
  if (req.message === 'init') {
    res({}) // prevent re-injecting

    if (!jcrop) {
      image(() => init(() => {
        overlay()
        capture()
      }))
    }
    else {
      overlay()
      capture(true)
    }
  }
  
  // Handle messages from background script for AI Screen Watcher
  if (req.action === 'startSelection') {
    console.log('AI Watcher: Received startSelection message');
    const success = startSelection();
    res({ success });
    return true; // Keep the message channel open for the async response
  }
  
  // Add a simple ping handler to check if content script is loaded
  if (req.action === 'ping') {
    console.log('AI Watcher: Received ping');
    res({ success: true });
    return true;
  }
  
  return false;
})

// Global variables - define as window properties to avoid duplicate declarations
if (!window.aiWatcherVars) {
  window.aiWatcherVars = {
    isSelecting: false,
    startX: null,
    startY: null,
    endX: null,
    endY: null,
    selectionBox: null,
    pixelOverlay: null,
    pixelCounter: null,
    showPixelOverlay: false,
    scriptInjected: false
  };
}

// For convenience, create local references to the global variables
const vars = window.aiWatcherVars;

// Create grid overlay and pixel counter
function createOverlays() {
  // Create selection box
  if (!vars.selectionBox) {
    vars.selectionBox = document.createElement('div');
    vars.selectionBox.className = 'ai-watcher-selection-box';
    vars.selectionBox.style.display = 'none';
    document.body.appendChild(vars.selectionBox);
  }
  
  // Create pixel counter
  if (!vars.pixelCounter) {
    vars.pixelCounter = document.createElement('div');
    vars.pixelCounter.className = 'ai-watcher-pixel-counter';
    vars.pixelCounter.style.display = 'none';
    document.body.appendChild(vars.pixelCounter);
  }
  
  // Create pixel overlay
  if (!vars.pixelOverlay) {
    vars.pixelOverlay = document.createElement('div');
    vars.pixelOverlay.className = 'ai-watcher-pixel-overlay';
    vars.pixelOverlay.style.display = 'none';
    document.body.appendChild(vars.pixelOverlay);
  }
}

// Add styles for selection
function addStyles() {
  const style = document.createElement('style');
  style.textContent = `
    .ai-watcher-selection-box {
      position: fixed;
      background-color: rgba(66, 133, 244, 0.2);
      border: 2px solid rgba(66, 133, 244, 0.8);
      z-index: 2147483647;
      pointer-events: none;
    }
    
    .ai-watcher-pixel-counter {
      position: fixed;
      background-color: rgba(0, 0, 0, 0.7);
      color: white;
      padding: 5px 8px;
      border-radius: 4px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 12px;
      z-index: 2147483647;
      pointer-events: none;
    }
    
    .ai-watcher-pixel-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background-image: url("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAB3RJTUUH4QgLEhkLQ6c1hwAAAB1pVFh0Q29tbWVudAAAAAAAQ3JlYXRlZCB3aXRoIEdJTVBkLmUHAAAAJklEQVQ4y2NkYGD4z0ABYGJgYGCgzKD/DAwMjKOGjho6aigZAACYUgJCLMlJyAAAAABJRU5ErkJggg==");
      opacity: 0.1;
      z-index: 2147483646;
      pointer-events: none;
      display: none;
    }
  `;
  document.head.appendChild(style);
}

// Initialize content script
function initContentScript() {
  if (vars.scriptInjected) {
    console.log('AI Watcher: Content script already initialized.');
    return;
  }
  vars.scriptInjected = true;
  console.log('AI Watcher: Initializing content script...');
  addStyles();
  createOverlays();

  // Listen for messages ONLY from the background script
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Very important: Ignore messages not from our extension's background
    if (!sender.id || sender.id !== chrome.runtime.id) {
        console.warn('AI Watcher: Ignoring message from unknown sender:', sender);
        return false; // Indicate message not handled
    }

    console.log('AI Watcher (Content): Received message from background:', message);
    try {
      if (message.action === 'startSelection') {
        sendResponse({ success: startSelection() });
      } else if (message.action === 'togglePixelOverlay') {
        sendResponse({ success: togglePixelOverlay(message.show) });
      } else {
         // Let the original script handle its messages if needed
         return false; // Indicate message not handled by this listener
      }
    } catch (error) {
      console.error('AI Watcher (Content): Error handling message:', error, message);
      sendResponse({ success: false, error: error.message });
    }
    return true; // Keep the message channel open for async response
  });
  console.log('AI Watcher: Content script listener attached.');
}

// Start area selection
function startSelection() {
  console.log('AI Watcher: Starting selection process...');
  // Ensure overlays are ready
  createOverlays();

  // Make sure no previous listeners are active
  stopSelectionListeners();

  // Add mouse event listeners for selection
  document.addEventListener('mousedown', handleMouseDown, { capture: true, once: false });
  document.addEventListener('mousemove', handleMouseMove, { capture: true, once: false });
  document.addEventListener('mouseup', handleMouseUp, { capture: true, once: false });

  // Show pixel overlay if enabled
  if (vars.showPixelOverlay && vars.pixelOverlay) {
    vars.pixelOverlay.style.display = 'block';
  }

  // Notify user or update cursor style
  document.body.style.cursor = 'crosshair';

  return true;
}

function stopSelectionListeners() {
    document.removeEventListener('mousedown', handleMouseDown, { capture: true });
    document.removeEventListener('mousemove', handleMouseMove, { capture: true });
    document.removeEventListener('mouseup', handleMouseUp, { capture: true });
    document.body.style.cursor = 'default'; // Restore cursor
    console.log('AI Watcher: Selection listeners removed.');
}

// Handle mouse down event
function handleMouseDown(e) {
  // Only handle left mouse button and ensure it's a direct click, not inside an input etc.
  if (e.button !== 0 || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
      // If selection was in progress, maybe cancel it?
      // stopSelectionListeners(); // Optional: cancel if clicked elsewhere
      return;
  }

  e.preventDefault(); // Prevent default browser drag behavior
  e.stopPropagation(); // Stop event from bubbling up

  // Start selection
  vars.isSelecting = true;
  vars.startX = e.clientX;
  vars.startY = e.clientY;
  vars.endX = e.clientX;
  vars.endY = e.clientY;

  // Show selection box
  if (vars.selectionBox) {
    vars.selectionBox.style.display = 'block';
    updateSelectionBox();
  }

  // Show pixel counter
  if (vars.pixelCounter) {
    vars.pixelCounter.style.display = 'block';
    updatePixelCounter(e); // Pass event for initial positioning
  }
  console.log(`AI Watcher: Mouse down at (${vars.startX}, ${vars.startY})`);
}

// Handle mouse move event
function handleMouseMove(e) {
  if (!vars.isSelecting) return;

  e.preventDefault();
  e.stopPropagation();

  // Update selection end point
  vars.endX = e.clientX;
  vars.endY = e.clientY;

  // Update selection box
  updateSelectionBox();

  // Update pixel counter
  updatePixelCounter(e);
}

// Handle mouse up event
function handleMouseUp(e) {
  if (!vars.isSelecting) return;

  e.preventDefault();
  e.stopPropagation();

  // Stop selection
  vars.isSelecting = false;
  console.log(`AI Watcher: Mouse up at (${vars.endX}, ${vars.endY})`);

  // Final update of selection end point
  vars.endX = e.clientX;
  vars.endY = e.clientY;

  // Remove mouse event listeners *immediately*
  stopSelectionListeners();

  // Hide overlays
  if (vars.pixelCounter) vars.pixelCounter.style.display = 'none';
  if (vars.pixelOverlay) vars.pixelOverlay.style.display = 'none';

  // Calculate selected area
  const area = calculateSelectedArea();

  // Check if the selection is valid (minimum size)
  if (area.width < 5 || area.height < 5) {
    console.log('AI Watcher: Selection too small, ignoring.');
    if (vars.selectionBox) vars.selectionBox.style.display = 'none'; // Hide the small box
    return; // Don't send if too small
  }

  // Hide selection box *after* calculation
  if (vars.selectionBox) vars.selectionBox.style.display = 'none';

  // Send selected area to background script
  console.log('AI Watcher: Sending selected area to background:', area);
  chrome.runtime.sendMessage({
    action: 'areaSelected',
    data: area
  }, response => {
      if (chrome.runtime.lastError) {
          console.error('AI Watcher: Error sending areaSelected message:', chrome.runtime.lastError);
      } else {
          console.log('AI Watcher: areaSelected message sent, response:', response);
      }
  });
}

// Update selection box position and size
function updateSelectionBox() {
  // Calculate selection box dimensions
  const left = Math.min(vars.startX, vars.endX);
  const top = Math.min(vars.startY, vars.endY);
  const width = Math.abs(vars.endX - vars.startX);
  const height = Math.abs(vars.endY - vars.startY);
  
  // Update selection box
  vars.selectionBox.style.left = `${left}px`;
  vars.selectionBox.style.top = `${top}px`;
  vars.selectionBox.style.width = `${width}px`;
  vars.selectionBox.style.height = `${height}px`;
}

// Update pixel counter and position
function updatePixelCounter(event) {
  if (!vars.pixelCounter) return;
  // Calculate selected area
  const area = calculateSelectedArea();

  // Update pixel counter text
  vars.pixelCounter.textContent = `${area.width} × ${area.height} (${(area.width * area.height).toLocaleString()} px)`;

  // Position pixel counter near the cursor
  if (event) {
      const counterWidth = vars.pixelCounter.offsetWidth;
      const counterHeight = vars.pixelCounter.offsetHeight;
      let counterX = event.clientX + 15; // Offset from cursor
      let counterY = event.clientY + 15;

      // Adjust if counter goes off-screen
      if (counterX + counterWidth > window.innerWidth - 10) {
        counterX = event.clientX - counterWidth - 15;
      }
      if (counterY + counterHeight > window.innerHeight - 10) {
        counterY = event.clientY - counterHeight - 15;
      }
      // Ensure it's not negative
      counterX = Math.max(5, counterX);
      counterY = Math.max(5, counterY);

      vars.pixelCounter.style.left = `${counterX}px`;
      vars.pixelCounter.style.top = `${counterY}px`;
  }
}

// Calculate selected area
function calculateSelectedArea() {
  const left = Math.min(vars.startX, vars.endX);
  const top = Math.min(vars.startY, vars.endY);
  const width = Math.abs(vars.endX - vars.startX);
  const height = Math.abs(vars.endY - vars.startY);
  
  return {
    left,
    top,
    width,
    height,
    devicePixelRatio: window.devicePixelRatio || 1
  };
}

// Toggle pixel overlay
function togglePixelOverlay(show) {
  vars.showPixelOverlay = show;
  if (vars.pixelOverlay) {
    vars.pixelOverlay.style.display = show ? 'block' : 'none';
  }
  return true;
}

// --- Initialization --- //
// Only initialize if the script hasn't been injected before
if (typeof window.aiWatcherVars === 'undefined' || !window.aiWatcherVars.scriptInjected) {
    initContentScript();
}
