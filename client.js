// Inline AudioWorklet processor code
const audioProcessorCode = `
class AudioProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input.length > 0) {
      const inputData = input[0];
      
      // Convert float32 PCM to int16 PCM
      const int16Data = new Int16Array(inputData.length);
      for (let i = 0; i < inputData.length; i++) {
        const s = Math.max(-1, Math.min(1, inputData[i]));
        int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Send to main thread
      this.port.postMessage(int16Data.buffer, [int16Data.buffer]);
    }
    
    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
`;

 const API_KEY = '';

// --- Live API config ---
const model = 'gemini-2.5-flash-native-audio-preview-12-2025';
const config = {
  responseModalities: ['AUDIO'],
  systemInstruction: `You are a helpful and friendly AI assistant. 

When users ask you to write, create, generate, or show content like poems, code, stories, recipes, or lists:
1. Call the display_text function with the content - do NOT speak about calling the function
2. Only say a brief natural response like "Here you go!" or "Here's what you asked for"

When users ask you to execute shell commands:
1. Call the execute function with the shell command
2. Wait for confirmation from the user
3. The command will be executed after confirmation

When users ask you to search something on Google, use the googleSearch function.

For normal conversation, just speak naturally.

Do not narrate your actions or explain what you're doing - just do it.`,
  tools: [{
    functionDeclarations: [{
      name: 'display_text',
      description: 'Display text content to the user without speaking it aloud. Use this for poems, code, long-form content, lists, or anything the user asks you to write.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'A brief title or label for the content (e.g., "Poem", "Python Code", "Recipe")'
          },
          content: {
            type: 'string',
            description: 'The actual text content to display'
          }
        },
        required: ['content']
      }
    }, {
      name: 'execute',
      description: 'Execute a shell command. The command will be shown to the user for confirmation before execution.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The shell command to execute'
          }
        },
        required: ['command']
      }
    }, {
      name: 'googleSearch',
      description: 'Search Google for information',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query'
          }
        },
        required: ['query']
      }
    }]
  }]
};

let mediaRecorder = null;
let audioContext = null;
let session = null;
let isConnected = false;
let audioQueue = [];
let isPlayingAudio = false;
let nextPlayTime = 0;

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusDiv = document.getElementById('status');
const apiKeyInput = document.getElementById('apiKey');
const visualizer = document.getElementById('visualizer');
const canvasCtx = visualizer.getContext('2d');
const transcriptDiv = document.getElementById('transcript');
const textInputSection = document.getElementById('textInputSection');
const textInput = document.getElementById('textInput');
const sendBtn = document.getElementById('sendBtn');

function updateStatus(message, type = 'disconnected') {
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
}

async function startConversation() {
  const apiKey = apiKeyInput.value.trim() || API_KEY;
  
  if (!apiKey) {
    updateStatus('Please enter an API key', 'error');
    return;
  }

  try {
    startBtn.disabled = true;
    updateStatus('Connecting...', 'disconnected');

    // Initialize audio context
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });

    // Request microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Connect to Gemini Live API using WebSocket
    const ws = new WebSocket(
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`
    );

    session = ws;

    ws.onopen = () => {
      console.log('Connected to Gemini Live API');
      updateStatus('Connected - Speak or type!', 'connected');
      isConnected = true;
      stopBtn.disabled = false;
      visualizer.classList.add('active');
      textInputSection.style.display = 'block';

      // Send setup message
      ws.send(JSON.stringify({
        setup: {
          model: `models/${model}`,
          generation_config: {
            response_modalities: config.responseModalities,
          },
          system_instruction: {
            parts: [{ text: config.systemInstruction }]
          },
          tools: config.tools
        }
      }));

      // Setup audio recording
      setupAudioRecording(stream, ws);
    };

    ws.onmessage = async (event) => {
      try {
        let message;
        if (event.data instanceof Blob) {
          const text = await event.data.text();
          message = JSON.parse(text);
        } else {
          message = JSON.parse(event.data);
        }
        console.log('Received message:', message);

        // Handle tool/function calls
        if (message.toolCall?.functionCalls) {
          console.log('Function call detected!');
          for (const functionCall of message.toolCall.functionCalls) {
            console.log('Function:', functionCall.name, 'Args:', functionCall.args);
            if (functionCall.name === 'display_text') {
              const args = functionCall.args;
              if (transcriptDiv) {
                const textElement = document.createElement('div');
                textElement.className = 'message assistant written';
                const title = args.title ? `<strong>${args.title}</strong><br>` : '';
                textElement.innerHTML = `${title}<pre>${args.content}</pre>`;
                transcriptDiv.appendChild(textElement);
                transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
              }
              
              // Send function response back
              ws.send(JSON.stringify({
                toolResponse: {
                  functionResponses: [{
                    response: { success: true },
                    id: functionCall.id
                  }]
                }
              }));
            } else if (functionCall.name === 'execute') {
              const args = functionCall.args;
              const command = args.command || '';
              
              // Show command and ask for confirmation
              const confirmElement = document.createElement('div');
              confirmElement.className = 'message assistant';
              confirmElement.innerHTML = `
                <strong>Execute Command:</strong><br>
                <code>${command}</code><br>
                <button class="confirm-btn" data-command="${command.replace(/"/g, '&quot;')}" data-call-id="${functionCall.id}">Confirm</button>
                <button class="cancel-btn" data-call-id="${functionCall.id}">Cancel</button>
              `;
              transcriptDiv.appendChild(confirmElement);
              transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
              
              // Add event listeners for buttons
              confirmElement.querySelector('.confirm-btn').addEventListener('click', async (e) => {
                const cmd = e.target.getAttribute('data-command');
                const callId = e.target.getAttribute('data-call-id');
                
                // Execute command
                try {
                  const response = await fetch('http://localhost:5000/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ command: cmd, confirmed: true })
                  });
                  const result = await response.json();
                  
                  // Show result
                  const resultElement = document.createElement('div');
                  resultElement.className = 'message assistant';
                  resultElement.innerHTML = `
                    <strong>Command Result:</strong><br>
                    <pre>${result.stdout || result.stderr || 'Command executed'}</pre>
                  `;
                  transcriptDiv.appendChild(resultElement);
                  transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
                  
                  // Send function response back
                  ws.send(JSON.stringify({
                    toolResponse: {
                      functionResponses: [{
                        response: { 
                          success: result.success,
                          output: result.stdout,
                          error: result.stderr
                        },
                        id: callId
                      }]
                    }
                  }));
                } catch (err) {
                  console.error('Execute error:', err);
                  ws.send(JSON.stringify({
                    toolResponse: {
                      functionResponses: [{
                        response: { success: false, error: err.message },
                        id: callId
                      }]
                    }
                  }));
                }
                
                confirmElement.remove();
              });
              
              confirmElement.querySelector('.cancel-btn').addEventListener('click', (e) => {
                const callId = e.target.getAttribute('data-call-id');
                
                // Send cancellation response
                ws.send(JSON.stringify({
                  toolResponse: {
                    functionResponses: [{
                      response: { success: false, cancelled: true },
                      id: callId
                    }]
                  }
                }));
                
                confirmElement.remove();
              });
            } else if (functionCall.name === 'googleSearch') {
              const args = functionCall.args;
              const query = args.query || '';
              
              // Open Google search in new tab
              window.open(`https://www.google.com/search?q=${encodeURIComponent(query)}`, '_blank');
              
              // Show in transcript
              const searchElement = document.createElement('div');
              searchElement.className = 'message assistant';
              searchElement.innerHTML = `<strong>Google Search:</strong> ${query}`;
              transcriptDiv.appendChild(searchElement);
              transcriptDiv.scrollTop = transcriptDiv.scrollHeight;
              
              // Send function response back
              ws.send(JSON.stringify({
                toolResponse: {
                  functionResponses: [{
                    response: { success: true, query: query },
                    id: functionCall.id
                  }]
                }
              }));
            }
          }
          // Skip processing audio/text responses when there's a function call
          return;
        }

        // Handle regular response (only if no function call)
        if (message.serverContent?.modelTurn?.parts) {
          for (const part of message.serverContent.modelTurn.parts) {
            // Skip text parts - they're just model thinking/hallucinations
            // Only handle audio response
            if (part.inlineData?.data) {
              audioQueue.push(part.inlineData.data);
              if (!isPlayingAudio) {
                playAudioQueue();
              }
            }
          }
        }
        
        // Handle interrupted response
        if (message.serverContent?.interrupted) {
          console.log('Response interrupted');
          // Clear audio queue on interruption
          audioQueue = [];
          isPlayingAudio = false;
        }
      } catch (error) {
        console.error('Error processing message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      updateStatus('Connection error', 'error');
    };

    ws.onclose = (event) => {
      console.log('WebSocket closed:', event.reason);
      updateStatus('Disconnected', 'disconnected');
      cleanup();
    };

  } catch (error) {
    console.error('Error starting conversation:', error);
    updateStatus(`Error: ${error.message}`, 'error');
    startBtn.disabled = false;
  }
}

function setupAudioRecording(stream, ws) {
  // Setup audio visualization
  const audioSource = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  audioSource.connect(analyser);
  
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function drawVisualizer() {
    if (!isConnected) return;
    
    requestAnimationFrame(drawVisualizer);
    analyser.getByteFrequencyData(dataArray);

    canvasCtx.fillStyle = '#f8f9fa';
    canvasCtx.fillRect(0, 0, visualizer.width, visualizer.height);

    const barWidth = (visualizer.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * visualizer.height;

      const gradient = canvasCtx.createLinearGradient(0, 0, 0, visualizer.height);
      gradient.addColorStop(0, '#667eea');
      gradient.addColorStop(1, '#764ba2');
      
      canvasCtx.fillStyle = gradient;
      canvasCtx.fillRect(x, visualizer.height - barHeight, barWidth, barHeight);

      x += barWidth + 1;
    }
  }

  drawVisualizer();

  // Create inline AudioWorklet module
  const blob = new Blob([audioProcessorCode], { type: 'application/javascript' });
  const workletUrl = URL.createObjectURL(blob);
  
  // Use AudioWorklet for audio processing
  audioContext.audioWorklet.addModule(workletUrl).then(() => {
    URL.revokeObjectURL(workletUrl);
    const workletNode = new AudioWorkletNode(audioContext, 'audio-processor');
    audioSource.connect(workletNode);
    workletNode.connect(audioContext.destination);

    workletNode.port.onmessage = (event) => {
      if (!isConnected || ws.readyState !== WebSocket.OPEN) return;

      const int16Buffer = event.data;
      const base64Audio = btoa(String.fromCharCode(...new Uint8Array(int16Buffer)));
      
      // Send audio data to API
      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{
            data: base64Audio,
            mimeType: 'audio/pcm'
          }]
        }
      }));
    };

    mediaRecorder = { workletNode, stream };
  }).catch(err => {
    console.error('Failed to load audio worklet:', err);
  });
}

function sendTextMessage() {
  const message = textInput.value.trim();
  if (!message || !session || !isConnected) return;

  try {
    // Display user message in transcript
    const userElement = document.createElement('div');
    userElement.className = 'message user';
    userElement.textContent = `You: ${message}`;
    transcriptDiv.appendChild(userElement);
    transcriptDiv.scrollTop = transcriptDiv.scrollHeight;

    // Send text input to API
    session.send(JSON.stringify({
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{ text: message }]
        }],
        turnComplete: true
      }
    }));

    textInput.value = '';
  } catch (error) {
    console.error('Error sending text:', error);
  }
}

async function playAudioQueue() {
  if (audioQueue.length === 0) {
    isPlayingAudio = false;
    return;
  }

  isPlayingAudio = true;
  const base64Data = audioQueue.shift();

  try {
    // Decode base64 to binary
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Convert PCM to AudioBuffer
    const pcmData = new Int16Array(bytes.buffer);
    const floatData = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      floatData[i] = pcmData[i] / 32768.0;
    }

    const audioBuffer = audioContext.createBuffer(1, floatData.length, 24000);
    audioBuffer.getChannelData(0).set(floatData);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioContext.destination);
    
    // Schedule playback to eliminate gaps
    const currentTime = audioContext.currentTime;
    if (nextPlayTime < currentTime) {
      nextPlayTime = currentTime;
    }
    
    source.onended = () => {
      playAudioQueue();
    };
    
    source.start(nextPlayTime);
    nextPlayTime += audioBuffer.duration;
  } catch (error) {
    console.error('Error playing audio:', error);
    playAudioQueue();
  }
}

function stopConversation() {
  if (session) {
    session.close();
  }
  cleanup();
}

function cleanup() {
  isConnected = false;
  audioQueue = [];
  isPlayingAudio = false;
  nextPlayTime = 0;
  
  if (mediaRecorder) {
    if (mediaRecorder.workletNode) {
      mediaRecorder.workletNode.disconnect();
    }
    if (mediaRecorder.stream) {
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
    }
  }
  
  if (audioContext && audioContext.state !== 'closed') {
    audioContext.close();
  }

  mediaRecorder = null;
  audioContext = null;
  session = null;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  visualizer.classList.remove('active');
  textInputSection.style.display = 'none';
  updateStatus('Not connected', 'disconnected');
  if (transcriptDiv) {
    transcriptDiv.innerHTML = '';
  }
}

startBtn.addEventListener('click', startConversation);
stopBtn.addEventListener('click', stopConversation);
sendBtn.addEventListener('click', sendTextMessage);
textInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    sendTextMessage();
  }
});

// Set canvas size
visualizer.width = visualizer.offsetWidth;
visualizer.height = 100;
