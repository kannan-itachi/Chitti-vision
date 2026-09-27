# CHITTI VISION 3.3

An Enthiran-style vision and voice assistant HUD. Chitti watches through your webcam, identifies and learns objects, listens and talks back, thinks on its own, reads your documents and remembers you. It is a full rebuild of `chitti2.0.1.html` with the same concept and a better design, and it **works fully offline**.

| Layer | Tech |
|---|---|
| Frontend (HUD) | React 19 + Vite, Zustand, Canvas 2D, TensorFlow.js (COCO-SSD + MobileNet v2), Web Speech API, Web Audio |
| Offline mind | Rule-based brain, cognition loop, k-NN object learning, all running in the browser |
| Backend (brain) | Node.js + Express 5, BM25 document search, **Ollama (offline LLM)** or Claude (cloud), Wikipedia proxy, JSON persistence |

## Run it

```bash
cd chitti-vision-3
npm install
npm run models        # once, with internet: saves the vision models locally (~97 MB)
npm run dev
```

Open the URL Vite prints (usually **http://localhost:5173**) in **Chrome or Edge**. Click **INITIALIZE**, then allow the camera and microphone.

For production use `npm run build && npm start`. That serves everything from **http://127.0.0.1:8787**.

## What works offline

| Feature | Offline? | How |
|---|---|---|
| Object detection (80 types) | ✅ | SSD MobileNet v2 loaded from `client/public/models` |
| Identify anything (1000 types) | ✅ | MobileNet v2 re-checks each box and the object in the centre, so a fan is no longer called a "toilet" |
| Learn your own objects | ✅ | `learn this as my fan`: image fingerprints saved in the browser |
| Face detection + recognition | ✅ | BlazeFace face scan; say `my name is Kanna` on camera and Chitti greets you by name next time |
| Colour, motion, light sensing | ✅ | Pixel analysis on small frames |
| Conversation | ✅ | Local **Ollama** model (auto-started), plus the built-in offline mind |
| Self-thinking | ✅ | Cognition loop in the browser |
| Memory, timers, maths, "where is my…" | ✅ | Offline mind |
| Documents (PDF/DOCX/TXT…) | ✅ | Local server, BM25 search |
| Voice output | ✅ | Offline Windows voices are picked automatically |
| Voice input | ⚠️ | On-device recognition if your Chrome supports it; otherwise Chrome sends audio to Google. You can always type |
| Wikipedia, Claude | ❌ | Need internet (optional) |

**The brain picks itself:** Claude if `ANTHROPIC_API_KEY` is set → a local Ollama model (`llama3.2`, `llama3.1`, …) → the built-in offline mind. The top bar shows which one is active: **CLAUDE**, **LOCAL AI** or **MIND**.

## Try saying

**Vision:** `what is this?` · `learn this as my fan` · `what color is this?` · `what do you see?` · `where is my phone?` · `scan` · `lock target person` · `what have you learned` · `forget fan`

**Knowledge:** `what is India` · `who is Rajinikanth` · `tell me about the Taj Mahal` · `what is the capital of India` · `define gravity` (Wikipedia; specific questions are answered by the AI using the article)

**Mind:** `hi chitti` · `my name is Kanna` · `remember that my keys are in the drawer` · `what do you remember` · `set a timer for 5 minutes` · `remind me in 10 minutes to drink water` · `what is 15 percent of 200` · `tell me a joke` · `what are you thinking`

**System:** `red chip mode` · `calm mode` · `research mode` · `set mission find my bottle` · `upload file` · `question: …` · `wiki Enthiran` · `system check` · `thinking off` · `settings` · `stop talking` · `wake word on` · `help`

## Self-learning knowledge

When Chitti does not know something, it researches it by itself. Say "what is India", "why is the sky blue" or "how does a rainbow form" and it looks the topic up on Wikipedia. With a language core online, it answers in its own words from what it found. Everything it learns is saved in the browser, so it can answer again later, even offline. Follow-ups continue the topic: **"explain more"**, **"tell me more"**, **"explain it"**, **"in simple words"**, **"what does that mean"**. "What is this?" also describes the object it identifies, and newly seen objects are researched in the background.

## Automatic modes

With **auto mode** on (the default, shown as AUTO on the mode chip), Chitti:

- switches to **research** mode for knowledge questions
- engages the **red chip** (combat) when it sees a real threat (a knife, scissors, or a crowd)
- returns to **calm** when things are clear

Choosing a mode yourself pauses auto switching for 5 minutes. Say `auto mode off` to turn it off.

## Self-thinking (neural stream)

Every 1.5 seconds Chitti reflects on what it perceives. It writes thoughts to the **NEURAL STREAM** panel and speaks the important ones:

- It greets you when you arrive (using your name) and notes when you leave.
- **Mission watch:** after `set mission find my bottle`, it tells you when and where it sees the bottle.
- It warns about knives or scissors, crowds, and lighting that's too dark.
- **Curiosity:** when it isn't sure what something is, it asks you to teach it.
- It suggests a break after about 25 minutes in front of the screen.
- It remembers where it last saw each object, so `where is my …` works.
- It runs periodic self-diagnostics.

Turn this off with `thinking off`, or in **Settings (⚙)**.

## Voice

Chitti uses a natural-sounding voice while you're online (Google UK English Male in Chrome, or a "Natural" voice in Edge). Offline it switches to an installed Windows voice automatically. Chitti speaks at full volume. On Windows, audio can still get lowered while a microphone is open. Open **Sound settings → More sound settings → Communications** and choose **Do nothing**. **Settings (⚙)** also lets you pick the voice and set volume, speed and pitch.

## Project structure

```
client/src/
  lib/vision.js         camera, detector loop, smart re-identification, HUD renderer
  lib/perception.js     MobileNet classifier, learned objects (k-NN), colour, motion, light
  lib/models.js         local-first model loaders
  lib/tracker.js        IoU tracker, range + threat estimation
  lib/mind.js           offline brain + self-thinking cognition loop + personal memory
  lib/speech.js         TTS queue, on-device recognition, watchdog, wake word
  lib/commands.js       intent patterns + help list
  lib/actions.js        command router, streaming AI, learning, uploads
  components/           BootSequence, TopBar, LeftDeck (optics, targets, focus, radar,
                        telemetry), CommsPanel, ThoughtsPanel, KnowledgePanel, CoreOrb,
                        CommandBar, InfoCard, UploadScanner, SettingsPanel, Toasts
server/src/
  index.js              REST + Server-Sent Events API
  brain.js              picks Claude → Ollama → none
  claude.js / ollama.js language core providers
  prompt.js             Chitti persona + telemetry-grounded turns
  knowledge.js          text extraction, chunking, BM25 search
scripts/fetch-models.mjs  downloads vision models for offline use
```

## Configuration (`server/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | enables Claude (cloud, can also see camera frames) |
| `CHITTI_MODEL` | `claude-opus-5` | Claude model |
| `OLLAMA_MODEL` | auto | e.g. `llama3.2`; use a vision model like `llava` so the local brain can see frames too |
| `OLLAMA_AUTOSTART` | `true` | start `ollama serve` automatically |
| `PORT` | `8787` | server port |
