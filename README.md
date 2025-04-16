# Screen Scoutr: Monitor & Analysis

> **Transform your browser from a simple viewer to an intelligent guardian of your digital experience.**

**Install: [Chrome]** 
<!-- / **[Edge]** / **[Opera]** / **[Brave]** / **[Chromium]** / **[Vivaldi]** -->

![Screen Scoutr Logo](icons/default/128x128.png)

## 🔥 Features

- 📸 **Smart Screen Capture** - Capture exactly what you need with precision
- 🧠 **AI-Powered Analysis** - Automatically detect and classify screen content
- 🔔 **Customizable Alerts** - Get notified when specific content is detected
- 🔒 **Privacy-First Design** - All processing happens locally in your browser
- ⚙️ **Flexible Configuration** - Tailor the extension to your specific needs
- 🎯 **Multiple Capture Methods** - Viewport, crop & save, or crop & wait
- 🖼️ **Versatile Output Options** - Save to PNG/JPG or copy to clipboard
- 📱 **HDPI Display Support** - Perfect for high-resolution displays
- ⚡ **Keyboard Shortcuts** - Boost your productivity with quick commands
- 🌐 **Open Source** - Free, transparent, and community-driven

## What Makes Screen Scoutr Special?

Screen Scoutr goes beyond simple screenshot functionality by incorporating intelligent visual analysis. Whether you're monitoring for specific UI elements, tracking visual changes over time, or setting up alerts for particular content patterns, Screen Scoutr leverages vision language models (VLMs) to bring context-aware intelligence to your browsing experience.

## Table of Contents

- [Getting Started](#getting-started)
- [How to Use](#how-to-use)
- [Capture Methods](#capture-methods)
- [Content Analysis](#content-analysis)
- [Alert Configuration](#alert-configuration)
- [Image Format](#image-format)
- [Screenshot Scaling](#screenshot-scaling)
- [Save Options](#save-options)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Save Location](#save-location)
- [Known Limitations](#known-limitations)
- [Installation Options](#installation-options)
- [License](#license)

## Getting Started

1. Pin the extension to your browser toolbar for easy access
2. Click on the extension button using your **Right** Mouse Button
3. Select `Options` from the context menu
4. Configure your preferred capture, analysis, and alert settings

## How to Use

### Setting Up API Access

1. **API Key Configuration**:
   - Navigate to the Settings tab in the extension
   - Enter your API key in the designated field
   - Without an API key, the VLM analysis features will not be available

2. **Model Selection**:
   - Choose from the dropdown menu of available models
   - Free models from Open Router are included by default
   - Pro tip: If you need a specific model that's not listed, use the "Request New Model" button
   - The model list is regularly updated with new options

### Single Image Analysis

1. **Capture Screen Content**:
   - Ensure you're on the tab you want to analyze
   - Click "Select Area" to manually define a region, or
   - Click "Capture Viewport" to automatically capture the entire visible area

2. **Add Context (Optional)**:
   - In the provided text field, enter any prompts or questions
   - Leave blank if you want the VLM to analyze without specific guidance

3. **Analyze the Image**:
   - Click the "Analyze Image" button
   - After processing (timing varies by model), results will appear below the image preview

### Continuous Monitoring

1. **Setup Monitoring**:
   - Navigate to the "Monitor" tab in the extension
   - Select the monitoring interval (minimum: 10 seconds)
   - Enter your monitoring prompt (e.g., "Alert me if this value changes")

2. **Start Monitoring**:
   - Click "Start Monitoring" to begin the automated analysis
   - The extension will capture and analyze the selected screen area at your specified interval

3. **Control Options**:
   - "Pause Monitoring" - Temporarily halt the process
   - "Stop Monitoring" - End the current monitoring session completely

### Viewing History

1. Access the "History" tab to review all previous analyses
2. Results are organized chronologically with timestamps
3. Filter or search through your history to find specific results

### Important Usage Notes

- **Window & Tab Management**:
  - The extension captures the **active tab** in the **active window**
  - If you switch tabs within the monitored window, the new active tab will be captured
  - For uninterrupted monitoring, keep the target tab active in its window
  - You can open a new browser window for other work while monitoring continues

- **API Quota Limitations**:
  - Free Open Router accounts: 50 requests per day per API key
  - For additional usage, you can create new accounts with new API keys
  - Unlimited quota available for Pro users (subject to rate limits)

- **Best Practices**:
  - For critical monitoring, consider using a dedicated browser window
  - More specific prompts generally yield more useful analysis results
  - Regular monitoring intervals (1-5 minutes) provide good coverage without excessive API usage

## Capture Methods

### **`Crop and Save`**

1. Activate the extension using your [keyboard shortcut](#keyboard-shortcuts) or by clicking the extension button
2. Hold down your left mouse button anywhere on the page and drag to select your area
3. Release the mouse button when ready - the selected area will be captured and saved

### **`Crop and Wait`**

1. Activate the extension using your [keyboard shortcut](#keyboard-shortcuts) or by clicking the extension button
2. Hold down your left mouse button anywhere on the page and drag to create a selection
3. Fine-tune the selected area by adjusting its position and size
4. When ready, activate the extension again to capture and save the selection

### **`Capture Viewport`**

1. Activate the extension using your [keyboard shortcut](#keyboard-shortcuts) or by clicking the extension button
2. The entire visible area of the screen will be instantly captured

## Content Analysis

Screen Scoutr leverages cutting-edge vision language models to analyze captured content:

- **`Pattern Recognition`** - Identify specific visual elements and patterns
- **`Content Classification`** - Automatically categorize and tag screen content
- **`Text Extraction`** - Pull out relevant text from visual elements
- **`Change Detection`** - Identify differences between captures over time
- **`Custom Detectors`** - Set up specialized monitors for your specific needs

## Alert Configuration

Configure personalized alerts based on what matters to you:

- **`Content-Based Alerts`** - Get notified when specific content appears
- **`Pattern Matching`** - Set triggers for visual or textual patterns
- **`Threshold Controls`** - Adjust sensitivity and confidence thresholds
- **`Alert Channels`** - Choose between browser notifications, sounds, or visual indicators
- **`Alert History`** - Review past detections and alerts

## Image Format

- **`PNG`** - Superior image quality with lossless compression. Ideal for screenshots with text, UI elements, or when quality is critical. Larger file size.

- **`JPG`** - More efficient file size with minimal quality loss. Perfect for capturing photographs, videos, or when storage space is a concern. Adjustable quality from 100 (highest) to 0 (lowest).

## Screenshot Scaling

- **`Preserve scaling`** - Maintain the display scaling you see on screen, capturing exactly what you perceive.

- **`Downscale to actual size`** - Automatically optimize for HDPI displays (like Retina) or zoomed pages by downscaling to original size.

## Save Options

- **`To File`** - Save directly to your device:
  - Automatic saving to your [preferred location](#save-location)
  - Manual save prompt for more control
  - Customizable naming conventions

- **`To Clipboard`** - Copy for immediate use elsewhere:
  - **`Data URL String`** - Technical format for web development
  - **`Binary Image`** - Ready for pasting in image editors
  - **`Confirmation Dialog`** - Optional verification step

## Keyboard Shortcuts

1. Navigate to `chrome://extensions/shortcuts`
2. Find Screen Scoutr and set your preferred key combination
3. Default suggestion: `Alt+S` (customizable)

*Pro tip: Create different shortcuts for different capture methods through the extension settings!*

## Save Location

1. Navigate to `chrome://settings/downloads`
2. Set your preferred download destination
3. Toggle `Ask where to save each file before downloading` for manual control

## Known Limitations

Screen Scoutr won't function on:

- Browser settings pages (`chrome://` and `chrome-extension://`)
- Chrome Web Store (`https://chromewebstore.google.com/`)
- Your designated home page

For local file access:

1. Go to `chrome://extensions`
2. Find Screen Scoutr and click `Details`
3. Enable `Allow access to file URLs`

Clipboard considerations:

- Requires secure contexts (HTTPS or localhost)
- Viewport capture requires clipboard permission
- PDF documents require the Crop and Save method

## Installation Options

The following options work for: Chrome, Edge, Opera, Brave, Chromium and Vivaldi.

*Note: Manual installation methods won't receive automatic updates.*

### Web Store Installation (Recommended)

Click the relevant store link at the top of this page for your browser.

### Manual .crx Installation

1. Download the latest `screen-scoutr.crx` from [releases]
2. Navigate to `chrome://extensions`
3. Enable Developer mode
4. Drag and drop the file onto the extensions page

### Load Unpacked

1. Download and extract `screen-scoutr.zip` from [releases]
2. Navigate to `chrome://extensions`
3. Enable Developer mode
4. Click `Load unpacked` and select the extracted directory

### Build From Source

1. Clone this repository
2. Run `sh build/package.sh chrome`
3. Load the extension through `chrome://extensions`

## License

The MIT License (MIT)

Copyright (c) 2023-present Your Organization/Name

*Based on the original Screenshot Capture extension by Simeon Velichkov*

[chrome]: https://chromewebstore.google.com/detail/<coming soon>
<!-- [edge]: https://microsoftedge.microsoft.com/addons/detail/screenshot-capture/fjmanmejbodljeaicnkgdgibdbeheela
[opera]: https://chromewebstore.google.com/detail/screenshot-capture/giabbpobpebjfegnpcclkocepcgockkc
[brave]: https://chromewebstore.google.com/detail/screenshot-capture/giabbpobpebjfegnpcclkocepcgockkc
[chromium]: https://chromewebstore.google.com/detail/screenshot-capture/giabbpobpebjfegnpcclkocepcgockkc
[vivaldi]: https://chromewebstore.google.com/detail/screenshot-capture/giabbpobpebjfegnpcclkocepcgockkc

[releases]: https://github.com/yourusername/screen-scoutr/releases -->
