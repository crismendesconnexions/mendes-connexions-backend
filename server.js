// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const helmet = require('helmet');
const fs = require('fs'); // Adicionado para manipulação de arquivos
const https = require('https'); // Adicionado para configuração SSL

const app = express();

// 🔐 Configurações de Segurança
app.use(helmet());
app.disable('x-powered-by');

app.use(cors());
app.use(express.json());

// 🔹 Inicializar Firebase Admin usando variável de ambiente
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (err) {
    console.error('Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err);
    process.exit(1);
  }
} else {
  console.error('FIREBASE_SERVICE_ACCOUNT não definido!');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET
});
const db = admin.firestore();

// 🔹 Credenciais Santander (seguras no backend)
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: process.env.SANTANDER_COVENANT_CODE,
  PARTICIPANT_CODE: process.env.SANTANDER_PARTICIPANT_CODE,
  DICT_KEY: process.env.SANTANDER_DICT_KEY
};

// 🔹 Configuração do Multer para Upload de Certificados
// Criar diretório temporário se não existir
const uploadDir = '/tmp/certificados';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const nomeUnico = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
    cb(null, nomeUnico);
  }
});

const fileFilter = (req, file, cb) => {
  // Aceitar apenas arquivos de certificado
  const allowedExtensions = /(\.crt|\.key|\.pem)$/i;
  const allowedMimes = [
    'application/x-x509-ca-cert',
    'application/x-pem-file',
    'text/plain'
  ];

  if (allowedMimes.includes(file.mimetype) || allowedExtensions.test(file.originalname)) {
    cb(null, true);
  } else {
    cb(new Error('Apenas arquivos de certificado (.crt, .key, .pem) são permitidos!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 1024 * 1024 * 5 // Limite de 5MB
  }
});

// 🔹 Middleware de autenticação
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'Token de acesso não fornecido' });

    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    res.status(401).json({ error: 'Token inválido' });
  }
};

// 🔹 Handler assíncrono para evitar código repetitivo
const asyncHandler = fn => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// 🔹 Rota para upload de certificados
app.post('/api/upload-certificados', authenticate, upload.fields([
  { name: 'certificadoCrt', maxCount: 1 },
  { name: 'certificadoKey', maxCount: 1 }
]), asyncHandler(async (req, res) => {
  if (!req.files || !req.files['certificadoCrt'] || !req.files['certificadoKey']) {
    return res.status(400).json({ error: 'Envie ambos os arquivos: .crt e .key' });
  }

  const fileCrt = req.files['certificadoCrt'][0];
  const fileKey = req.files['certificadoKey'][0];

  // Aqui você pode processar os certificados
  // Por exemplo, mover para Firebase Storage ou usar diretamente
  console.log('Certificado CRT salvo em:', fileCrt.path);
  console.log('Chave KEY salva em:', fileKey.path);

  res.json({
    success: true,
    message: 'Certificados recebidos com sucesso!',
    arquivos: {
      crt: fileCrt.filename,
      key: fileKey.filename
    }
  });
}));

// 🔹 Função para criar agente HTTPS com certificados
function createHttpsAgent(certPath, keyPath) {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.warn('Certificados não encontrados, usando conexão padrão');
    return null;
  }

  return new https.Agent({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
    rejectUnauthorized: false // Ajuste conforme necessidade do Santander
  });
}

// 🔹 Rota para obter token Santander (ATUALIZADA com suporte a certificados)
app.post('/api/santander/token', authenticate, asyncHandler(async (req, res) => {
  const formData = new URLSearchParams();
  formData.append('client_id', SANTANDER_CONFIG.CLIENT_ID);
  formData.append('client_secret', SANTANDER_CONFIG.CLIENT_SECRET);
  formData.append('grant_type', 'client_credentials');

  const config = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  };

  // 🔹 Usar certificados se disponíveis
  // Você pode ajustar os caminhos conforme sua configuração
  const certPath = process.env.SANTANDER_CERT_PATH || '/tmp/certificados/certificate.crt';
  const keyPath = process.env.SANTANDER_KEY_PATH || '/tmp/certificados/private.key';
  
  const httpsAgent = createHttpsAgent(certPath, keyPath);
  if (httpsAgent) {
    config.httpsAgent = httpsAgent;
  }

  try {
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      config
    );

    res.json(response.data);
  } catch (error) {
    console.error('Erro detalhado ao obter token Santander:', {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status
    });
    res.status(500).json({
      error: 'Falha ao obter token',
      details: error.response?.data || error.message
    });
  }
}));

// 🔹 Rota para registrar boleto
app.post('/api/santander/boletos', authenticate, asyncHandler(async (req, res) => {
  const { dadosBoleto } = req.body;

  if (!dadosBoleto) {
    return res.status(400).json({ error: 'Dados do boleto não fornecidos' });
  }

  try {
    // Obter token primeiro
    const tokenResponse = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      new URLSearchParams({
        client_id: SANTANDER_CONFIG.CLIENT_ID,
        client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
        grant_type: 'client_credentials'
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );
    
    const accessToken = tokenResponse.data.access_token;
    const workspaceId = await obterWorkspaceId(accessToken);

    const nsuCode = gerarNumeroUnico(dadosBoleto.clientNumber);
    const bankNumber = await gerarBankNumberSequencial();

    // 🔹 Montar payload completo do boleto
    const payload = {
      nsuCode: nsuCode,
      bankNumber: bankNumber,
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
      // Adicione outros campos conforme documentação do Santander
      ...dadosBoleto
    };

    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );

    // Salvar no Firestore
    const boletoRef = await db.collection('boletos').add({
      ...payload,
      accessToken: accessToken, // Considere a segurança disso
      workspaceId: workspaceId,
      dataCriacao: new Date(),
      status: 'pendente'
    });

    res.json({
      ...boletoResponse.data,
      id: boletoRef.id
    });

  } catch (error) {
    console.error('Erro ao registrar boleto:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Falha ao registrar boleto',
      details: error.response?.data || error.message
    });
  }
}));

// 🔹 Rota para gerar PDF do boleto (CORRIGIDA)
app.post('/api/santander/boletos/pdf', authenticate, asyncHandler(async (req, res) => {
  const { digitableLine, payerDocumentNumber } = req.body;

  if (!digitableLine || !payerDocumentNumber) {
    return res.status(400).json({ error: 'Linha digitável e documento do pagador são obrigatórios' });
  }

  try {
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

    const pdfResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      { payerDocumentNumber },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        responseType: 'stream' // Para lidar com PDF
      }
    );

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="boleto-${digitableLine}.pdf"`
    });

    pdfResponse.data.pipe(res);

  } catch (error) {
    console.error('Erro ao gerar PDF:', error.response?.data || error.message);
    res.status(500).json({
      error: 'Falha ao gerar PDF',
      details: error.response?.data || error.message
    });
  }
}));

// 🔹 Funções auxiliares
function gerarNumeroUnico(clientNumber) {
  return `${clientNumber}-${Date.now()}`;
}

async function gerarBankNumberSequencial() {
  // Implementação real usando banco de dados
  try {
    const counterRef = db.collection('counters').doc('bankNumber');
    const counter = await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(counterRef);
      if (!doc.exists) {
        transaction.set(counterRef, { sequence: 1 });
        return 1;
      }
      const newSequence = doc.data().sequence + 1;
      transaction.update(counterRef, { sequence: newSequence });
      return newSequence;
    });
    return counter;
  } catch (error) {
    console.error('Erro ao gerar sequencial:', error);
    return Math.floor(Math.random() * 1000000);
  }
}

async function obterWorkspaceId(accessToken) {
  // Implementação para obter ou criar workspace
  // Esta é uma implementação de exemplo - ajuste conforme a API do Santander
  try {
    const response = await axios.get(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID
        }
      }
    );
    
    if (response.data && response.data.length > 0) {
      return response.data[0].id;
    }
    
    // Se não existir, criar um novo workspace
    const createResponse = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      {
        name: 'Workspace Principal',
        description: 'Workspace para gestão de boletos'
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID
        }
      }
    );
    
    return createResponse.data.id;
  } catch (error) {
    console.error('Erro ao obter workspace:', error);
    return 'workspace-default'; // Fallback
  }
}

// 🔹 Handlers de erro globais
app.use((req, res, next) => {
  res.status(404).json({ error: "Rota não encontrada" });
});

app.use((err, req, res, next) => {
  console.error('Erro global:', err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Arquivo muito grande. Limite é 5MB.' });
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Campo de arquivo inesperado.' });
    }
  }
  
  res.status(500).json({ error: 'Algo deu errado no servidor!' });
});

// 🔹 Health check
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend online',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV}`);
});
