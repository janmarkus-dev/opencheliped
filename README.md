# Opencheliped
> A web-based multimodal personal assistant using Gemini live API for life automation.

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
python3 -m http server 8000
# Open localhost:8000
```
