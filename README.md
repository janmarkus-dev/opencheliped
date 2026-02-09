# Gemini Voice Assistant

A web-based voice chat interface for Google's Gemini Live API with real-time audio processing.

## Setup

1. Get a Google Gemini API key from [Google AI Studio](https://aistudio.google.com)
2. Enter your API key in the web interface
3. Start a conversation using voice or text

## ⚠️ Security

- **Never commit API keys** - add to `.gitignore` if you store them locally
- **Local use only** - run `server.py` on `localhost`, not on public networks
- **Command execution** - the `execute` function runs shell commands with user confirmation. Use only in trusted environments

## Running

```bash
python3 server.py
# Open index.html in your browser
```
