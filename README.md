# chatbot-backend

NestJS API for the chatbot platform — WhatsApp, conversations, messages, channels, and realtime.

## Setup

```bash
npm install
cp .env.example .env
npx prisma migrate dev
npm run start:dev
```

## Environment

Copy `.env.example` to `.env` and set `DATABASE_URL`, `JWT_SECRET`, and other values.
