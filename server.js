// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const fs = require('fs');
const https = require('https');

const app = express();

// 🔐 Segurança
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.disable('x-powered-by');

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
    message: 'Backend online e funcionando',
    timestamp: new Date().toISOString(),
    service: 'Mendes Connexions Backend',
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3001,
    uptime: `${process.uptime().toFixed(2)} segundos`
  });
});

// 🔹 Rota de teste sem autenticação
app.get('/test', (req, res) => {
  res.status(200).json({
    message: 'Backend está respondendo sem autenticação',
    status: 'success',
    timestamp: new Date().toISOString()
  });
});

// 🔹 Inicializar Firebase
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err);
  }
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET
    });
    console.log('Firebase Admin inicializado');
  } catch (error) {
    console.error('Erro ao inicializar Firebase Admin:', error);
  }
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

// 🔹 Multer upload certificados
const uploadDir = '/tmp/certificados';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const nomeUnico = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, nomeUnico);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = /(\.crt|\.key|\.pem)$/i;
  const allowedMimes = [
    'application/x-x509-ca-cert',
    'application/x-pem-file',
    'text/plain'
  ];
  if (allowedMimes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) cb(null, true);
  else cb(new Error('Apenas arquivos .crt, .key ou .pem!'), false);
};

const upload = multer({ storage, fileFilter, limits: { fileSize: 5 * 1024 * 1024 } });

// 🔹 Autenticação Firebase
const authenticate = async (req, res, next) => {
  if (!admin.auth) return next();
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token não fornecido' });
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// 🔹 Handler assíncrono
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// 🔹 Upload certificados
app.post('/api/upload-certificados', authenticate, upload.fields([
  { name: 'certificadoCrt', maxCount: 1 },
  { name: 'certificadoKey', maxCount: 1 }
]), asyncHandler(async (req, res) => {
  if (!req.files || !req.files['certificadoCrt'] || !req.files['certificadoKey'])
    return res.status(400).json({ error: 'Envie ambos os arquivos .crt e .key' });

  res.json({
    success: true,
    message: 'Certificados recebidos!',
    arquivos: {
      crt: req.files['certificadoCrt'][0].filename,
      key: req.files['certificadoKey'][0].filename
    }
  });
}));

// 🔹 Agente HTTPS Santander
function createHttpsAgent() {
  try {
    const certBase64 = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    const keyBase64 = process.env.SANTANDER_PRIVATE_KEY_B64;
    if (!certBase64 || !keyBase64) return null;

    return new https.Agent({
      cert: Buffer.from(certBase64, 'base64').toString('utf-8'),
      key: Buffer.from(keyBase64, 'base64').toString('utf-8'),
      rejectUnauthorized: true
    });
  } catch (error) {
    console.error('Erro criar agente HTTPS:', error);
    return null;
  }
}

// 🔹 Obter token Santander
app.post('/api/santander/token', authenticate, asyncHandler(async (req, res) => {
  try {
    console.log('🔹 Requisição de token Santander...');
    const formData = new URLSearchParams();
    formData.append('client_id', SANTANDER_CONFIG.CLIENT_ID);
    formData.append('client_secret', SANTANDER_CONFIG.CLIENT_SECRET);
    formData.append('grant_type', 'client_credentials');

    const config = { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } };
    const httpsAgent = createHttpsAgent();
    if (httpsAgent) config.httpsAgent = httpsAgent;

    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      config
    );

    console.log('✅ Token gerado:', response.data.access_token);
    res.json(response.data);
  } catch (error) {
    console.error('❌ Erro token Santander:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao obter token', details: error.response?.data || error.message });
  }
}));

// 🔹 Criar workspace sempre
async function criarWorkspace(accessToken) {
  try {
    console.log('🔹 Criando workspace no Santander...');
    const payload = { name: 'Workspace Principal', description: 'Workspace para gestão de boletos' };
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'covenantCode': SANTANDER_CONFIG.COVENANT_CODE,
          'participantCode': SANTANDER_CONFIG.PARTICIPANT_CODE
        },
        httpsAgent: createHttpsAgent()
      }
    );
    console.log('✅ Workspace criado com sucesso:', response.data.id);
    return response.data.id;
  } catch (error) {
    console.error('❌ Erro ao criar workspace:', error.response?.data || error.message);
    throw new Error('Não foi possível criar workspace');
  }
}

// 🔹 Registrar boleto
app.post('/api/santander/boletos', authenticate, asyncHandler(async (req, res) => {
  const { dadosBoleto } = req.body;
  if (!dadosBoleto) return res.status(400).json({ error: 'Dados do boleto não fornecidos' });

  try {
    console.log('🔹 Gerando token antes de criar workspace...');
    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, httpsAgent: createHttpsAgent() }
    );
    const accessToken = tokenResponse.data.access_token;
    console.log('✅ Token obtido:', accessToken);

    const workspaceId = await criarWorkspace(accessToken);

    const payload = {
      nsuCode: `${dadosBoleto.clientNumber}-${Date.now()}`,
      bankNumber: await gerarBankNumberSequencial(),
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

    console.log('🔹 Registrando boleto...');
    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        httpsAgent: createHttpsAgent()
      }
    );

    console.log('✅ Boleto registrado com sucesso:', boletoResponse.data);

    if (db) {
      const boletoRef = await db.collection('boletos').add({ ...payload, workspaceId, status: 'pendente', dataCriacao: new Date() });
      res.json({ ...boletoResponse.data, id: boletoRef.id });
    } else {
      res.json(boletoResponse.data);
    }

  } catch (error) {
    console.error('❌ Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao registrar boleto', details: error.response?.data || error.message });
  }
}));

// 🔹 Gerar PDF boleto
app.post('/api/santander/boletos/pdf', authenticate, asyncHandler(async (req, res) => {
  const { digitableLine, payerDocumentNumber } = req.body;
  if (!digitableLine || !payerDocumentNumber) return res.status(400).json({ error: 'Linha digitável e documento obrigatórios' });

  try {
    console.log('🔹 Gerando token para PDF...');
    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const accessToken = tokenResponse.data.access_token;
    console.log('✅ Token obtido para PDF:', accessToken);

    console.log('🔹 Requisitando PDF do boleto...');
    const pdfResponse = await axios({
      method: 'post',
      url: `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      data: { payerDocumentNumber },
      headers: {
        'Content-Type': 'application/json',
        'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
        'Authorization': `Bearer ${accessToken}`
      },
      responseType: 'arraybuffer'
    });

    console.log('✅ PDF obtido com sucesso, enviando ao cliente...');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="boleto-${digitableLine}.pdf"`,
      'Content-Length': pdfResponse.data.length
    });
    res.send(Buffer.from(pdfResponse.data));

  } catch (error) {
    console.error('❌ Erro gerar PDF:', error.response?.data || error.message);
    res.status(500).json({ error: 'Falha ao gerar PDF', details: error.message });
  }
}));

// 🔹 Auxiliares
async function gerarBankNumberSequencial() {
  if (!db) return Math.floor(Math.random() * 1000000);
  try {
    const counterRef = db.collection('counters').doc('bankNumber');
    return await db.runTransaction(async (t) => {
      const doc = await t.get(counterRef);
      const newSeq = doc.exists ? doc.data().sequence + 1 : 1;
      t.set(counterRef, { sequence: newSeq }, { merge: true });
      return newSeq;
    });
  } catch {
    return Math.floor(Math.random() * 1000000);
  }
}

// 🔹 Handlers globais
app.use((req, res) => res.status(404).json({ error: "Rota não encontrada" }));
app.use((err, req, res, next) => {
  console.error('Erro global:', err.stack);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Arquivo muito grande. Limite 5MB.' });
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Campo de arquivo inesperado.' });
  }
  res.status(500).json({ error: 'Algo deu errado no servidor!' });
});

// 🔹 Inicialização
const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
});
