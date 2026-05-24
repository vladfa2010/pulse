import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth';
import newsRoutes from './routes/news';
import paymentRoutes from './routes/payment';
import userRoutes from './routes/user';
import translateRoutes from './routes/translate';
import webhookRoutes from './routes/webhook';
import adminRoutes from './routes/admin';
import { startCron } from './services/cron';
import { startReportCron } from './services/reports';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/news', newsRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/user', userRoutes);
app.use('/api/translate', translateRoutes);
app.use('/api/webhook', webhookRoutes);
app.use('/api/admin', adminRoutes);

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`PULSE backend running on port ${PORT}`);
  console.log(`Routes: /api/auth, /api/news, /api/payment, /api/user, /api/translate, /api/webhook, /api/admin`);

  // Start cron jobs
  startCron();
  startReportCron();
});
