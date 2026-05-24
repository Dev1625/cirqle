# 🚀 Cirqle CRM Complete Deployment Guide

To deploy **Cirqle** as a fully functional, live production website where users can sign up, log in, and securely access AI features, we deploy the system in two separate, optimized layers:

1. **Frontend App (React / Vite)**: Built as a static Single Page Application (SPA), hosted on a global CDN (**Vercel** or **Netlify**) for free, high-speed delivery.
2. **AI API Proxy Gateway (LiteLLM + Redis)**: Containerized backend service hosted on a container platform (**Render**, **Railway**, or **DigitalOcean VPS**) that handles your secure master keys, Redis caching, and user budget/rate limits.

```
┌─────────────────────────────────┐
│     Client's Web Browser        │
│  (Static assets loaded from)    │
└────────┬────────────────┬───────┘
         │                │
         │ (UI Actions)   │ (API Requests / Virtual Key)
         ▼                ▼
┌─────────────────┐  ┌────────────────────────────────────┐
│ Vercel Hosting  │  │ Render / Railway Gateway Service   │
│ (Frontend Site) │  │ (LiteLLM Proxy + Redis Backend)    │
└─────────────────┘  └─────────────────┬──────────────────┘
                                       │
                                       ▼
                             ┌───────────────────┐
                             │ Google & OpenAI   │
                             │   Direct APIs     │
                             └───────────────────┘
```

---

## 📂 Component 1: Deploying the Frontend (Vercel - Free Tier)

Vercel is the industry standard for Vite/React applications. It is free, automatically rebuilds when you push to GitHub, and provides instant SSL.

### Step 1: Push Your Code to GitHub
Ensure all your files (including `src/lib/gemini.ts` and the `litellm-proxy` folder) are committed to a GitHub repository:
```bash
git init
git add .
git commit -m "feat: complete proxy setup and frontend client alignment"
git remote add origin https://github.com/YOUR_USERNAME/cirqle-crm.git
git branch -M main
git push -u origin main
```

### Step 2: Import into Vercel
1. Log in to [Vercel](https://vercel.com) using your GitHub account.
2. Click **Add New** ➔ **Project**.
3. Import your `cirqle-crm` repository.
4. Vercel will automatically detect **Vite** as the framework and configure the build command (`npm run build`) and output directory (`dist`).

### Step 3: Configure Frontend Environment Variables
Before clicking "Deploy", expand the **Environment Variables** section and add:
* **`VITE_GATEWAY_URL`**: `https://your-litellm-proxy-url.com` (You will get this URL from deploying Component 2 below).

### Step 4: Click Deploy 🚀
Vercel will build your static files and give you a public URL (e.g., `https://cirqle-crm.vercel.app`).

---

## ⚙️ Component 2: Deploying the API Proxy Backend

Since the API Proxy requires Docker and a background Redis database, we deploy it to a platform supporting containers.

### Option A: Railway (Highly Recommended - Easiest Setup)
Railway provides one-click hosting for multi-container Docker Compose architectures.

1. Create a free account at [Railway.app](https://railway.app).
2. Click **New Project** ➔ **Deploy from GitHub repo**.
3. Select your repository.
4. Railway will analyze your project structure. Point it to the `litellm-proxy` directory, or upload a custom Docker Compose.
5. Railway will automatically spin up two services matching our `docker-compose.yml`: `litellm-proxy` and `redis`.
6. Add your production environment variables in Railway's UI settings:
   - `LITELLM_MASTER_KEY`: Your secure master token starting with `sk-`
   - `LITELLM_SALT_KEY`: A long random security salt string
   - `OPENAI_API_KEY`: Your actual OpenAI key
   - `GEMINI_API_KEY`: Your actual Google Gemini key
7. Railway will generate a public domain for your proxy (e.g., `https://cirqle-proxy-production.up.railway.app`). **Copy this URL and save it in Vercel's `VITE_GATEWAY_URL` variable!**

---

### Option B: Render (Free Tier Container & Redis)
Render provides free Web Services for Dockerized apps.

#### 1. Deploy the Redis Cache
1. In the [Render Dashboard](https://dashboard.render.com), click **New** ➔ **Redis**.
2. Name it `cirqle-redis` and click **Create**.
3. Once active, copy the **Internal Redis URL** (e.g., `redis://red-xxxxxxxxxx:6379`).

#### 2. Deploy the LiteLLM Proxy
1. Click **New** ➔ **Web Service**.
2. Connect your GitHub repository.
3. In the Settings:
   - **Root Directory**: `litellm-proxy`
   - **Runtime**: `Docker`
4. Expand **Environment Variables** and add:
   - `LITELLM_MASTER_KEY`: Your secure admin key starting with `sk-`
   - `LITELLM_SALT_KEY`: A random security salt string
   - `OPENAI_API_KEY`: Your actual OpenAI key
   - `GEMINI_API_KEY`: Your actual Google Gemini key
   - `REDIS_HOST`: The host part of your Render Redis internal URL (e.g., `red-xxxxxxxxxx`)
   - `REDIS_PORT`: `6379`
   - `DATABASE_URL`: `sqlite:////data/litellm.db`
5. Under **Disk** / **Volume**:
   - Create a persistent disk mount.
   - **Mount Path**: `/data`
   - **Size**: 1 GB (perfect for SQLite keys and transaction logs).
6. Click **Deploy**. Render will build the LiteLLM container and provide a secure public URL (e.g., `https://cirqle-proxy.onrender.com`).

---

### Option C: DigitalOcean Droplet (For Full Ownership & Scaling)
If you want to run the exact `docker-compose.yml` file without third-party platform limitations.

1. Spin up a basic Ubuntu Droplet ($4/month - $6/month).
2. SSH into your droplet and install Docker & Docker Compose:
   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose
   ```
3. Create your configuration directory and clone the `litellm-proxy` folder:
   ```bash
   mkdir -p /app/litellm-proxy
   ```
4. Copy `config.yaml`, `docker-compose.yml`, and your active `.env` file into `/app/litellm-proxy`.
5. Run Docker Compose:
   ```bash
   cd /app/litellm-proxy
   docker compose up -d --build
   ```
6. The proxy will be instantly accessible globally at your droplet's public IP address `http://YOUR_DROPLET_IP:4000`.

---

## 🔄 User Signup & Virtual Key Workflow

Once the CRM frontend (Vercel) and Proxy (Render/Railway) are both live:
1. **User Sign Up**: Users visit your Vercel website and sign up using the Firebase Authentication UI.
2. **Assigning an API Key**:
   - *Option A (Admin/Manual)*: You generate a capped virtual key for the user using the administrative `/key/generate` endpoint, and assign it to them.
   - *Option B (Automated - Recommended)*: You can add a short script or a Firebase Cloud Function that automatically triggers when a user signs up. The backend script calls the proxy's `/key/generate` endpoint using the `LITELLM_MASTER_KEY` to create a virtual key capped at $5.00 spend.
3. **Storage & Access**: The generated virtual key is saved in the user's Firestore document (e.g., `users/{userId}/apiKey`).
4. **Frontend Execution**: When the frontend client boots up, it reads the user's custom `apiKey` from Firestore and saves it in `localStorage.setItem('CIRQLE_USER_PROXY_KEY', apiKey)`.
5. **Seamless Routing**: Every time they use an AI feature, `src/lib/gemini.ts` instantiates the `@google/genai` client using their unique virtual key, routing all calls through your secure Render/Railway proxy.
