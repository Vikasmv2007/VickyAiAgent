# Vicky — Personal AI Event & Hackathon Assistant

Vicky is a personal AI assistant that keeps track of your events, workshops, and hackathons across Google Calendar, multiple Gmail inboxes, a mobile-first React PWA dashboard, and Telegram.

---

## Project Structure

```text
.
├── backend/                  # Standalone Python + FastAPI backend (for local / Render / Railway + Telegram + APScheduler)
│   ├── main.py               # FastAPI server + Google multi-account OAuth routes
│   ├── agent.py              # Gemini API brain with function calling + Tavily search
│   ├── calendar_tools.py     # Google Calendar create/list/delete + IST + 1d/1h reminders + duplicate check
│   ├── gmail_tools.py        # Multi-account read-only Gmail scanner
│   ├── telegram_bot.py       # Telegram bot (/today, /week, /add, /hackathons, /accounts, voice notes)
│   ├── scheduler.py          # APScheduler (Asia/Kolkata): 8:00 AM daily digest + 30-min Gmail scan
│   ├── db.py                 # Local SQLite database for refresh tokens & processed IDs
│   ├── requirements.txt
│   └── .env.example
├── src/                      # React + Vite + Tailwind PWA frontend (mobile-first dark UI)
├── server.ts                 # Node/Express + Vite server used for the live web preview
├── public/                   # PWA icons & manifest assets
└── README.md
```

---

## Step 1: Get Your API Keys & Credentials

### 1. Google Cloud Project + Calendar & Gmail APIs + OAuth Test User
1. Go to [Google Cloud Console](https://console.cloud.google.com/) and click **New Project** (name it `Vicky Assistant`).
2. In the left menu, go to **APIs & Services > Library**:
   - Search **Google Calendar API** -> click **Enable**.
   - Search **Gmail API** -> click **Enable**.
3. Go to **APIs & Services > OAuth consent screen**:
   - Choose **External** -> click **Create**.
   - Fill in App name (`Vicky`), User support email, and Developer contact email.
   - Click **Save and Continue** through **Scopes** (or add `calendar.events` and `gmail.readonly`).
   - On the **Test users** step, click **+ Add Users** and add **your Gmail address(es)** (add all Gmail accounts you want to scan!). This is required so Google lets you sign in while the app is in Testing mode.
4. Go to **APIs & Services > Credentials > + Create Credentials > OAuth client ID**:
   - Application type: **Web application**
   - Authorized JavaScript origins: `http://localhost:3000` (and later your Vercel URL)
   - Authorized redirect URIs: `http://localhost:8000/auth/google/callback` (and later `https://your-backend.onrender.com/auth/google/callback`)
   - Copy your **Client ID** and **Client Secret**.

### 2. Gemini API Key (Free Tier)
1. Open [Google AI Studio](https://aistudio.google.com/apikey).
2. Click **Create API Key** and copy it for `GEMINI_API_KEY`.

### 3. Tavily Web Search API Key (Free Tier)
1. Sign up at [Tavily](https://tavily.com/) (free tier gives 1,000 searches/month).
2. Copy your API key for `TAVILY_API_KEY`.

### 4. Telegram Bot Token & Chat ID
1. Open Telegram and message **@BotFather**.
2. Send `/newbot`, choose a name (`Vicky`) and username (must end in `bot`, e.g., `vicky_events_bot`).
3. Copy the **Bot Token** BotFather gives you (`TELEGRAM_BOT_TOKEN`).
4. Message **@userinfobot** on Telegram to get your numeric **Id** (`TELEGRAM_CHAT_ID`).
5. Open your new bot in Telegram and press **Start** so it can send you morning digests.

---

## Step 2: Run Locally

### A. Run the Python + FastAPI Backend (Terminal 1)
```bash
cd backend
python -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # Fill in your keys in backend/.env
uvicorn main:app --reload --port 8000
```
- Connect multiple Gmail accounts by visiting `http://localhost:8000/auth/google/start` in your browser for each Gmail account you want to link. Refresh tokens are saved locally in `backend/vicky.db`.

### B. Run the React + Vite PWA Frontend (Terminal 2)
```bash
npm install
npm run dev
```
Open `http://localhost:3000` (or point `vite.config.ts` proxy `/api` to `http://localhost:8000` when using the standalone Python backend).

---

## Step 3: Deploy for Free

### Backend on Render (or Railway)
1. Push this repo to GitHub.
2. On [Render](https://render.com/), create a **New Web Service** connected to your repo:
   - **Root Directory**: `backend`
   - **Build Command**: `pip install -r requirements.txt`
   - **Start Command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
3. Add all environment variables from `backend/.env.example` in Render's **Environment** tab (update `GOOGLE_REDIRECT_URI` to `https://<your-render-app>.onrender.com/auth/google/callback` and add that URL in Google Cloud Credentials).
4. *(Tip)* On Railway (`railway.app`), select the `backend/` folder with the same start command; Railway also keeps your background scheduler and Telegram polling bot running continuously.

### Frontend on Vercel
1. On [Vercel](https://vercel.com/), import your GitHub repository.
2. Framework Preset: **Vite**, Build Command: `npm run build`, Output Directory: `dist`.
3. Update `FRONTEND_URL` in your backend env vars to your `https://<your-app>.vercel.app` URL.

---

## Step 4: Wrap the PWA into an Android App with Capacitor

Once your frontend builds cleanly (`npm run build`), wrap it into a native Android APK:

```bash
# 1. Install Capacitor packages
npm install @capacitor/core @capacitor/cli @capacitor/android

# 2. Initialize Capacitor (only once)
npx cap init "Vicky" "com.vicky.assistant" --web-dir dist

# 3. Build the web app and add Android platform
npm run build
npx cap add android

# 4. Sync web build into the Android project (run this after any frontend change)
npm run build && npx cap sync android

# 5. Open in Android Studio to run on your phone or build an APK
npx cap open android
```
In `android/app/src/main/AndroidManifest.xml`, ensure microphone permission is enabled:
```xml
<uses-permission android:name="android.permission.RECORD_AUDIO" />
<uses-permission android:name="android.permission.INTERNET" />
```
