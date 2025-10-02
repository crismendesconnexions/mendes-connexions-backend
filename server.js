// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const https = require('https');

const app = express();

// 🔐 Segurança
app.use(helmet({ contentSecurityPolicy: false }));
app.disable('x-powered-by');

// 🔹 CORS
app.use(cors({
  origin: [
    'https://mendesconnexions.com.br',
    'https://www.mendesconnexions.com.br'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));
app.options('*', cors());

app.use(express.json());

// 🔹 Health Check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3001,
    uptime: `${process.uptime().toFixed(2)}s`
  });
});

// 🔹 Firebase Admin
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try { serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); }
  catch (err) { console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err); }
}
if (serviceAccount) {
  try { admin.initializeApp({ credential: admin.credential.cert(serviceAccount), storageBucket: process.env.FIREBASE_STORAGE_BUCKET }); }
  catch (error) { console.error('Erro ao inicializar Firebase Admin:', error); }
}
const db = admin.firestore ? admin.firestore() : null;

// 🔹 Config Santander
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE,
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE,
  DICT_KEY: process.env.SANTANDER_DICT_KEY
};

// 🔹 Gerar arquivos temporários de certificado
let tempCertPaths = null;
function prepareSantanderCertFiles() {
  if (tempCertPaths) return tempCertPaths;

  const crtBase64 = process.env.SANTANDER_CERTIFICATE_CRT_B64;
  const keyBase64 = process.env.SANTANDER_PRIVATE_KEY_B64;
  const passphrase = process.env.PASSPHRASE || undefined;

  if (!crtBase64 || !keyBase64) return null;

  const tmpDir = '/tmp/santander';
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const crtPath = path.join(tmpDir, 'certificado.crt');
  const keyPath = path.join(tmpDir, 'certificado.key');

  fs.writeFileSync(crtPath, Buffer.from(crtBase64, 'base64').toString('utf-8'));
  fs.writeFileSync(keyPath, Buffer.from(keyBase64, 'base64').toString('utf-8'));

  tempCertPaths = { crtPath, keyPath, passphrase };
  return tempCertPaths;
}

// 🔹 Criar HTTPS Agent
function getSantanderAgent() {
  const certFiles = prepareSantanderCertFiles();
  if (!certFiles) return null;

  return new https.Agent({
    cert: fs.readFileSync(certFiles.crtPath),
    key: fs.readFileSync(certFiles.keyPath),
    passphrase: certFiles.passphrase,
    rejectUnauthorized: true
  });
}

// 🔹 Middleware autenticação
const authenticate = async (req, res, next) => {
  if (!admin.auth) return next();
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch { res.status(401).json({ error: 'Token inválido' }); }
};

// 🔹 Handler assíncrono
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 🔹 Token Santander
app.post('/api/santander/token', authenticate, asyncHandler(async (req, res) => {
  const formData = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: SANTANDER_CONFIG.CLIENT_ID,
    client_secret: SANTANDER_CONFIG.CLIENT_SECRET
  });

  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      { httpsAgent: getSantanderAgent(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(response.data);
  } catch (error) {
    console.error('Erro ao obter token Santander:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao obter token', details: error.response?.data || error.message });
  }
}));

// 🔹 Obter Workspace
async function obterWorkspaceId(accessToken) {
  try {
    const response = await axios.get(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID }, httpsAgent: getSantanderAgent() }
    );
    if (response.data?.length) return response.data[0].id;

    const createResponse = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      { name: 'Workspace Principal', description: 'Workspace para gestão de boletos' },
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID }, httpsAgent: getSantanderAgent() }
    );
    return createResponse.data.id;
  } catch (error) {
    console.error('Erro ao obter workspace:', error.response?.data || error.message);
    throw new Error('Não foi possível obter ou criar workspace');
  }
}

// 🔹 Registrar boleto
app.post('/api/santander/boletos', authenticate, asyncHandler(async (req, res) => {
  const { dadosBoleto } = req.body;
  if (!dadosBoleto) return res.status(400).json({ error: 'Dados do boleto obrigatórios' });

  try {
    const tokenResp = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({ grant_type: 'client_credentials', client_id: SANTANDER_CONFIG.CLIENT_ID, client_secret: SANTANDER_CONFIG.CLIENT_SECRET }),
      { httpsAgent: getSantanderAgent(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResp.data.access_token;
    const workspaceId = await obterWorkspaceId(accessToken);

    const payload = {
      nsuCode: `${dadosBoleto.clientNumber}-${Date.now()}`,
      bankNumber: Math.floor(Math.random() * 1000000),
      valor: dadosBoleto.valor,
      pagador: {
        nome: dadosBoleto.pagadorNome,
        documento: dadosBoleto.pagadorDocumento,
        endereco: dadosBoleto.pagadorEndereco,
        cidade: dadosBoleto.pagadorCidade,
        estado: dadosBoleto.pagadorEstado,
        cep: dadosBoleto.pagadorCEP
      },
      dataVencimento: dadosBoleto.dataVencimento,
      ...dadosBoleto
    };

    const boletoResp = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      { headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID, 'Content-Type': 'application/json' }, httpsAgent: getSantanderAgent() }
    );

    if (db) {
      const boletoRef = await db.collection('boletos').add({ ...payload, workspaceId, status: 'pendente', dataCriacao: new Date() });
      return res.json({ ...boletoResp.data, id: boletoRef.id });
    }

    res.json(boletoResp.data);
  } catch (error) {
    console.error('Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao registrar boleto', details: error.response?.data || error.message });
  }
}));

// 🔹 PDF do Boleto
app.post('/api/santander/boletos/pdf', authenticate, asyncHandler(async (req, res) => {
  const { digitableLine, payerDocumentNumber } = req.body;
  if (!digitableLine || !payerDocumentNumber) return res.status(400).json({ error: 'Linha digitável e documento do pagador obrigatórios' });

  try {
    const tokenResp = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({ client_id: SANTANDER_CONFIG.CLIENT_ID, client_secret: SANTANDER_CONFIG.CLIENT_SECRET, grant_type: 'client_credentials' }),
      { httpsAgent: getSantanderAgent(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResp.data.access_token;

    const pdfResp = await axios({
      method: 'post',
      url: `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      data: { payerDocumentNumber },
      headers: { 'Authorization': `Bearer ${accessToken}`, 'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID, 'Content-Type': 'application/json' },
      responseType: 'arraybuffer',
      httpsAgent: getSantanderAgent()
    });

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="boleto-${digitableLine}.pdf"`, 'Content-Length': pdfResp.data.length });
    res.send(Buffer.from(pdfResp.data));
  } catch (error) {
    console.error('Erro ao gerar PDF:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao gerar PDF', details: error.response?.data || error.message });
  }
}));

// 🔹 Handlers globais
app.use((req, res) => res.status(404).json({ error: "Rota não encontrada" }));
app.use((err, req, res, next) => {
  console.error('Erro global:', err.stack);
  res.status(500).json({ error: 'Algo deu errado no servidor!', details: err.message });
});

// 🔹 Inicialização do servidor
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor rodando na porta ${PORT}`));
