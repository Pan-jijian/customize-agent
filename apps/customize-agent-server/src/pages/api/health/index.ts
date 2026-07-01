const startTime = Date.now();
export default function handler(_req: any, res: any) {
  res.status(200).json({ status: 'ok', uptime: Date.now() - startTime, timestamp: new Date().toISOString() });
}
