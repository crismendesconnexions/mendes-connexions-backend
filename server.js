// server.js
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');
const helmet = require('helmet');
const https = require('https');

const app = express();

// =============================================
// CONFIGURAÇÃO DE SEGURANÇA
// =============================================
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.disable('x-powered-by');

// =============================================
// CONFIGURAÇÃO CORS ATUALIZADA
// =============================================
const corsOptions = {
  origin: [
    'https://mendesconnexions.com.br',
    'https://www.mendesconnexions.com.br',
    'http://localhost:3000',
    'http://localhost:8080'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// =============================================
// MIDDLEWARES GLOBAIS
// =============================================
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Middleware de log para debug
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path}`, {
    body: req.body,
    headers: req.headers
  });
  next();
});

// =============================================
// MIDDLEWARE DE AUTENTICAÇÃO FIREBASE
// =============================================
const authenticateFirebase = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Token de autenticação não fornecido',
        details: 'Formato esperado: Bearer <token>'
      });
    }

    const token = authHeader.split('Bearer ')[1];

    if (!token) {
      return res.status(401).json({
        error: 'Token inválido',
        details: 'Token não encontrado no header Authorization'
      });
    }

    // Verificar se o Firebase Admin foi inicializado
    if (!admin.apps.length) {
      return res.status(500).json({
        error: 'Serviço de autenticação indisponível',
        details: 'Firebase Admin não inicializado'
      });
    }

    // Verificar token com Firebase Admin
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;

    console.log('✅ Usuário autenticado:', {
      uid: decodedToken.uid,
      email: decodedToken.email
    });

    next();
  } catch (error) {
    console.error('❌ Erro na autenticação Firebase:', error);

    return res.status(401).json({
      error: 'Token inválido ou expirado',
      details: error.message
    });
  }
};

// =============================================
// HEALTH CHECK
// =============================================
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend online e funcionando',
    timestamp: new Date().toISOString(),
    service: 'Mendes Connexions Backend',
    environment: process.env.NODE_ENV || 'development',
    port: process.env.PORT || 3001,
    uptime: `${process.uptime().toFixed(2)} segundos`,
    firebase: !!admin.apps.length
  });
});

// =============================================
// INICIALIZAÇÃO FIREBASE ADMIN
// =============================================
let serviceAccount;
let db = null;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } else {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT não encontrado nas variáveis de ambiente');
  }
} catch (err) {
  console.error('❌ Erro ao parsear FIREBASE_SERVICE_ACCOUNT:', err.message);
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.appspot.com`
    });
    console.log('✅ Firebase Admin inicializado com sucesso');
    db = admin.firestore();
  } catch (error) {
    console.error('❌ Erro crítico ao inicializar Firebase Admin:', error);
  }
} else {
  console.error('❌ Firebase Admin não inicializado - serviceAccount indisponível');
}

// =============================================
// CONFIGURAÇÃO SANTANDER
// =============================================
const SANTANDER_CONFIG = {
  CLIENT_ID: process.env.SANTANDER_CLIENT_ID,
  CLIENT_SECRET: process.env.SANTANDER_CLIENT_SECRET,
  COVENANT_CODE: parseInt(process.env.SANTANDER_COVENANT_CODE || "178622"),
  PARTICIPANT_CODE: "00000001",
  DICT_KEY: process.env.SANTANDER_DICT_KEY || "09199193000126"
};

// =============================================
// AGENTE HTTPS SANTANDER
// =============================================
function createHttpsAgent() {
  try {
    const certBase64 = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    const keyBase64 = process.env.SANTANDER_PRIVATE_KEY_B64;

    if (!certBase64 || !keyBase64) {
      console.error('❌ Certificado ou chave privada não encontrados');
      return null;
    }

    const cert = Buffer.from(certBase64, 'base64').toString('utf-8');
    const key = Buffer.from(keyBase64, 'base64').toString('utf-8');

    return new https.Agent({
      cert: cert,
      key: key,
      rejectUnauthorized: true,
      keepAlive: true
    });
  } catch (error) {
    console.error('❌ Erro ao criar agente HTTPS:', error.message);
    return null;
  }
}

// =============================================
// ✅ CORREÇÃO DEFINITIVA: FUNÇÕES DE DATA
// =============================================

/**
 * Formata data para YYYY-MM-DD no fuso de São Paulo
 */
function formatarDataParaSantander(date) {
  const dataSP = new Date(date.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const ano = dataSP.getFullYear();
  const mes = String(dataSP.getMonth() + 1).padStart(2, '0');
  const dia = String(dataSP.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/**
 * Calcula 5 dias úteis a partir da data atual
 */
function calcularCincoDiasUteis() {
  const hoje = new Date();
  let data = new Date(hoje);
  let diasUteis = 0;
  
  while (diasUteis < 5) {
    data.setDate(data.getDate() + 1);
    const diaSemana = data.getDay();
    
    // 0 = Domingo, 6 = Sábado
    if (diaSemana !== 0 && diaSemana !== 6) {
      diasUteis++;
    }
  }
  
  return formatarDataParaSantander(data);
}

/**
 * Gera data atual no fuso SP
 */
function gerarDataAtual() {
  return formatarDataParaSantander(new Date());
}

// =============================================
// ROTA: UPLOAD PARA CLOUDINARY
// =============================================
app.post('/api/cloudinary/upload-pdf', authenticateFirebase, async (req, res) => {
  try {
    const { pdfUrl, fileName, pontuacaoId } = req.body;

    console.log('☁️ Iniciando upload para Cloudinary via backend...');
    console.log('📄 Dados do upload:', { pdfUrl, fileName, pontuacaoId });

    // Validar dados obrigatórios
    if (!pdfUrl || !fileName) {
      return res.status(400).json({
        error: 'Dados incompletos',
        details: 'pdfUrl e fileName são obrigatórios'
      });
    }

    // Baixar o PDF
    console.log('⬇️ Baixando PDF da URL...');
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Erro ao baixar PDF: ${pdfResponse.status}`);
    }

    const pdfBlob = await pdfResponse.blob();
    console.log(`✅ PDF baixado com sucesso. Tamanho: ${pdfBlob.size} bytes`);

    // Fazer upload para Cloudinary
    console.log('⬆️ Iniciando upload para Cloudinary...');
    const formData = new FormData();
    formData.append('file', pdfBlob, fileName);
    formData.append('upload_preset', 'boletos');
    formData.append('folder', 'boletos-mendes-connexions');

    const cloudinaryResponse = await fetch(`https://api.cloudinary.com/v1_1/dno43pc3o/upload`, {
      method: 'POST',
      body: formData
    });

    if (!cloudinaryResponse.ok) {
      const errorData = await cloudinaryResponse.json();
      throw new Error(errorData.error?.message || 'Erro ao fazer upload para Cloudinary');
    }

    const cloudinaryData = await cloudinaryResponse.json();

    console.log('✅ Upload para Cloudinary realizado com sucesso:', cloudinaryData.secure_url);

    // Se temos um pontuacaoId, atualizar no Firebase
    if (pontuacaoId && db) {
      try {
        await db.collection('pontuacoes').doc(pontuacaoId).update({
          comprovanteUrl: cloudinaryData.secure_url,
          comprovantePublicId: cloudinaryData.public_id,
          comprovanteUploadedAt: new Date().toISOString()
        });
        console.log('✅ URL do comprovante salva no Firebase para pontuacaoId:', pontuacaoId);
      } catch (firebaseError) {
        console.error('⚠️ Erro ao salvar no Firebase, mas upload foi bem sucedido:', firebaseError);
        // Não falha a requisição se só o Firebase der erro
      }
    }

    res.json({
      success: true,
      cloudinaryUrl: cloudinaryData.secure_url,
      publicId: cloudinaryData.public_id,
      message: 'Upload realizado com sucesso'
    });

  } catch (error) {
    console.error('❌ Erro no upload para Cloudinary:', error);
    res.status(500).json({
      error: 'Erro ao fazer upload para Cloudinary: ' + error.message
    });
  }
});

// =============================================
// ROTA: DOWNLOAD VIA BACKEND (SOLUÇÃO DEFINITIVA)
// =============================================
app.get('/api/download-boleto/:pontuacaoId', authenticateFirebase, async (req, res) => {
  try {
    const { pontuacaoId } = req.params;
    
    console.log('📥 Iniciando download via backend para:', pontuacaoId);
    
    // Buscar dados da pontuação
    const pontuacaoDoc = await db.collection('pontuacoes').doc(pontuacaoId).get();
    
    if (!pontuacaoDoc.exists) {
      return res.status(404).json({ error: 'Pontuação não encontrada' });
    }
    
    const pontuacaoData = pontuacaoDoc.data();
    
    if (!pontuacaoData.comprovanteUrl) {
      return res.status(404).json({ error: 'PDF não disponível para download' });
    }
    
    const cloudinaryUrl = pontuacaoData.comprovanteUrl;
    console.log('🔗 Cloudinary URL:', cloudinaryUrl);
    
    // Fazer download do PDF do Cloudinary
    const pdfResponse = await fetch(cloudinaryUrl);
    
    if (!pdfResponse.ok) {
      console.error('❌ Erro ao baixar do Cloudinary:', pdfResponse.status);
      throw new Error(`Erro ao baixar PDF do Cloudinary: ${pdfResponse.status}`);
    }
    
    // Obter o buffer do PDF
    const pdfBuffer = await pdfResponse.buffer();
    
    // Verificar se é um PDF válido
    const contentType = pdfResponse.headers.get('content-type');
    if (!contentType || !contentType.includes('pdf')) {
      console.warn('⚠️ O conteúdo não é um PDF, tipo:', contentType);
      // Mesmo assim tentamos enviar como PDF
    }
    
    // Configurar headers para download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="boleto-${pontuacaoId}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    console.log('✅ Download via backend concluído. Tamanho:', pdfBuffer.length, 'bytes');
    
    // Enviar o PDF
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('❌ Erro no download via backend:', error);
    res.status(500).json({
      error: 'Erro ao baixar PDF: ' + error.message
    });
  }
});

// =============================================
// ROTA: DOWNLOAD DIRETO DO PDF (ALTERNATIVA)
// =============================================
app.get('/api/cloudinary/download-pdf', authenticateFirebase, async (req, res) => {
  try {
    const { publicId, fileName = 'boleto.pdf' } = req.query;
    
    if (!publicId) {
      return res.status(400).json({
        error: 'publicId é obrigatório'
      });
    }

    console.log('⬇️ Iniciando download direto do PDF:', publicId);
    
    // URL de download direto do Cloudinary com parâmetros para forçar download
    const downloadUrl = `https://res.cloudinary.com/dno43pc3o/raw/upload/fl_attachment:${fileName}/${publicId}`;
    
    console.log('🔗 URL de download:', downloadUrl);
    
    // Fazer o download do PDF do Cloudinary
    const response = await fetch(downloadUrl);
    
    if (!response.ok) {
      throw new Error(`Erro ao baixar PDF do Cloudinary: ${response.status}`);
    }
    
    // Obter o buffer do PDF
    const pdfBuffer = await response.buffer();
    
    // Configurar headers para forçar download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-cache');
    
    console.log('✅ PDF pronto para download:', {
      tamanho: pdfBuffer.length,
      fileName: fileName
    });
    
    // Enviar o PDF
    res.send(pdfBuffer);
    
  } catch (error) {
    console.error('❌ Erro no download do PDF:', error);
    res.status(500).json({
      error: 'Erro ao baixar PDF: ' + error.message
    });
  }
});

// =============================================
// ROTA: GERAR URL DE DOWNLOAD (ALTERNATIVA)
// =============================================
app.get('/api/cloudinary/download-url', authenticateFirebase, async (req, res) => {
  try {
    const { publicId, fileName = 'boleto.pdf' } = req.query;
    
    if (!publicId) {
      return res.status(400).json({
        error: 'publicId é obrigatório'
      });
    }

    // Gerar URL de download direto do Cloudinary
    const downloadUrl = `https://res.cloudinary.com/dno43pc3o/raw/upload/fl_attachment:${fileName}/${publicId}`;
    
    console.log('🔗 Gerando URL de download:', downloadUrl);
    
    res.json({
      success: true,
      downloadUrl: downloadUrl,
      fileName: fileName,
      message: 'URL de download gerada com sucesso'
    });
    
  } catch (error) {
    console.error('❌ Erro ao gerar URL de download:', error);
    res.status(500).json({
      error: 'Erro ao gerar URL de download: ' + error.message
    });
  }
});

// =============================================
// FUNÇÃO: BUSCAR CLIENT NUMBER
// =============================================
async function buscarClientNumber(lojistaId) {
  if (!db) {
    console.error('❌ Firestore não inicializado');
    return null;
  }

  try {
    console.log('🔍 Buscando clientNumber para lojista:', lojistaId);
    const lojistaDoc = await db.collection('lojistas').doc(lojistaId).get();

    if (!lojistaDoc.exists) {
      console.log('❌ Lojista não encontrado');
      return null;
    }

    const data = lojistaDoc.data();
    const clientNumber = data.clientNumber || data.idNumber;

    console.log('📋 Dados do lojista encontrado:', {
      exists: lojistaDoc.exists,
      clientNumber,
      nome: data.nomeFantasia || data.nome,
      cnpj: data.cnpj
    });

    return clientNumber?.toString() || null;
  } catch (error) {
    console.error('💥 Erro ao buscar clientNumber no Firebase:', error);
    return null;
  }
}

// =============================================
// FUNÇÃO: OBTER TOKEN SANTANDER (ATUALIZADA)
// =============================================
async function obterTokenSantander() {
  console.log("\n=== [1] Solicitando TOKEN Santander ===");

  const formData = new URLSearchParams({
    client_id: SANTANDER_CONFIG.CLIENT_ID,
    client_secret: SANTANDER_CONFIG.CLIENT_SECRET,
    grant_type: 'client_credentials',
    scope: 'collection_bill_management'
  });

  try {
    const httpsAgent = createHttpsAgent();
    if (!httpsAgent) throw new Error('Agente HTTPS não pôde ser criado (verifique certificados)');

    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          // Header de User-Agent ajuda a evitar bloqueios de WAF
          'User-Agent': 'MendesConnexions/1.0',
          'Accept': '*/*'
        },
        httpsAgent, // O agente carrega o certificado
        timeout: 30000
      }
    );

    console.log("✅ Token recebido com sucesso");
    return response.data.access_token;
  } catch (err) {
    // Log detalhado para identificar se o erro é no certificado ou na credencial
    const isCertificateError = err.code === 'ECONNRESET' || err.message.includes('socket hang up') || err.response?.status === 403;
    
    console.error("❌ Erro ao obter token Santander:", {
      tipo: isCertificateError ? 'PROVÁVEL ERRO DE CERTIFICADO/MTLS' : 'ERRO DE DADOS',
      status: err.response?.status,
      data: err.response?.data, // O HTML da Akamai aparece aqui
      message: err.message
    });
    throw err;
  }
}

// =============================================
// FUNÇÃO: CRIAR WORKSPACE
// =============================================
async function criarWorkspace(accessToken) {
  console.log("\n=== [2] Criando WORKSPACE ===");

  const payload = {
    type: "BILLING",
    description: "Workspace de Cobrança",
    covenants: [
      { code: SANTANDER_CONFIG.COVENANT_CODE }
    ]
  };

  console.log("➡️ Payload Workspace:", JSON.stringify(payload, null, 2));

  try {
    const httpsAgent = createHttpsAgent();
    if (!httpsAgent) throw new Error('Agente HTTPS não disponível');

    const response = await axios.post(
      'https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Accept': 'application/json'
        },
        httpsAgent,
        timeout: 30000
      }
    );

    console.log("✅ Workspace criada:", response.data.id);
    return response.data.id;
  } catch (error) {
    console.error("❌ Erro ao criar workspace:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    throw error;
  }
}

// =============================================
// FUNÇÃO: GERAR NSU (15 dígitos: YYMMDDHHMMSS + 3 dígitos sequenciais)
// =============================================
async function gerarNSU(clientNumber) {
  const agoraSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));

  const YY = String(agoraSP.getFullYear()).slice(-2);
  const MM = String(agoraSP.getMonth() + 1).padStart(2, '0');
  const DD = String(agoraSP.getDate()).padStart(2, '0');
  const HH = String(agoraSP.getHours()).padStart(2, '0');
  const min = String(agoraSP.getMinutes()).padStart(2, '0');
  const SS = String(agoraSP.getSeconds()).padStart(2, '0');

  // Gerar sequencial único
  if (!db) {
    console.error('❌ Firestore não inicializado para gerar NSU');
    return `${YY}${MM}${DD}${HH}${min}${SS}001`;
  }

  try {
    const ref = db.collection('config').doc('ultimoNSU');
    const doc = await ref.get();
    let ultimoSequencial = 0;

    if (doc.exists && doc.data()?.sequencial) {
      ultimoSequencial = parseInt(doc.data().sequencial);
    }

    const novoSequencial = (ultimoSequencial + 1) % 1000; // 000-999
    await ref.set({ sequencial: novoSequencial });

    const sequencialStr = String(novoSequencial).padStart(3, '0');
    const nsu = `${YY}${MM}${DD}${HH}${min}${SS}${sequencialStr}`;

    console.log(`🔢 NSU gerado (Fuso SP): ${nsu}`);
    return nsu;
  } catch (error) {
    console.error('❌ Erro ao gerar NSU:', error);
    // Fallback: timestamp + clientNumber
    return `${YY}${MM}${DD}${HH}${min}${SS}${String(clientNumber).slice(-3).padStart(3, '0')}`;
  }
}

// =============================================
// FUNÇÃO: GERAR bankNumber SEQUENCIAL
// =============================================
async function gerarBankNumber() {
  if (!db) {
    console.error('❌ Firestore não inicializado');
    return "0040";
  }

  try {
    const ref = db.collection('config').doc('ultimoBankNumber');
    const doc = await ref.get();
    let ultimo = 39; // começa antes de 40 para incrementar

    if (doc.exists && doc.data()?.value) {
      ultimo = parseInt(doc.data().value);
    }

    const novoBankNumber = ultimo + 1;
    await ref.set({ value: novoBankNumber });

    const bankNumberStr = String(novoBankNumber).padStart(4, '0');
    console.log(`🏦 BankNumber gerado: ${bankNumberStr}`);

    return bankNumberStr;
  } catch (error) {
    console.error('❌ Erro ao gerar bankNumber:', error);
    return "0040"; // Fallback
  }
}

// =============================================
// ROTA: REGISTRAR BOLETO (CORRIGIDA)
// =============================================
app.post('/api/santander/boletos', async (req, res) => {
  console.log("📥 Recebendo requisição para gerar boleto...");

  const { dadosBoleto, lojistaId } = req.body;
  if (!dadosBoleto || !lojistaId) {
    return res.status(400).json({
      error: 'Dados do boleto ou ID do lojista não fornecidos',
      details: 'Verifique se dadosBoleto e lojistaId estão presentes no corpo da requisição'
    });
  }

  try {
    // Buscar clientNumber do lojista
    const clientNumber = await buscarClientNumber(lojistaId);
    if (!clientNumber) {
      return res.status(400).json({
        error: 'ClientNumber do lojista não encontrado',
        details: `Lojista ${lojistaId} não possui clientNumber cadastrado no Firebase`
      });
    }

    // Obter token Santander
    const accessToken = await obterTokenSantander();

    // Criar workspace
    const workspaceId = await criarWorkspace(accessToken);

    // Gerar números únicos
    const bankNumber = await gerarBankNumber();
    const nsuCode = await gerarNSU(clientNumber);

    console.log("\n=== [3] Registrando BOLETO ===");

    // ✅ USANDO AS NOVAS FUNÇÕES CORRIGIDAS
    const dueDate = calcularCincoDiasUteis(); // 5 dias úteis a partir de hoje
    const nsuDate = gerarDataAtual(); // Data atual
    const issueDate = gerarDataAtual(); // Data atual

    // Payload simplificado e correto
    const payload = {
      environment: "PRODUCAO",
      nsuCode: nsuCode,
      nsuDate: nsuDate,
      covenantCode: SANTANDER_CONFIG.COVENANT_CODE,
      bankNumber: bankNumber,
      clientNumber: String(clientNumber).padStart(5, "0"),
      dueDate: dueDate,
      issueDate: issueDate,
      participantCode: SANTANDER_CONFIG.PARTICIPANT_CODE,
      nominalValue: parseFloat(dadosBoleto.valor).toFixed(2),
      payer: {
        name: dadosBoleto.pagadorNome.toUpperCase().substring(0, 40),
        documentType: "CNPJ",
        documentNumber: dadosBoleto.pagadorDocumento,
        address: dadosBoleto.pagadorEndereco.toUpperCase().substring(0, 40),
        neighborhood: dadosBoleto.bairro.toUpperCase().substring(0, 20),
        city: dadosBoleto.pagadorCidade.toUpperCase().substring(0, 20),
        state: dadosBoleto.pagadorEstado.toUpperCase(),
        zipCode: dadosBoleto.pagadorCEP.replace(/(\d{5})(\d{3})/, "$1-$2")
      },
      documentKind: "DUPLICATA_MERCANTIL",
      deductionValue: "0.00",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      messages: [
        "Boleto gerado via Mendes Connexions",
        "Em caso de dúvidas entre em contato"
      ],
      key: {
        type: "CNPJ",
        dictKey: SANTANDER_CONFIG.DICT_KEY
      }
    };

    console.log("📦 Payload Boleto Corrigido:", JSON.stringify(payload, null, 2));

    const httpsAgent = createHttpsAgent();
    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }

    // Registrar boleto no Santander
    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        httpsAgent,
        timeout: 30000
      }
    );

    console.log("✅ Boleto registrado com sucesso!");
    console.log("📋 Resposta Santander:", JSON.stringify(boletoResponse.data, null, 2));

    res.json({
      success: true,
      message: 'Boleto registrado com sucesso',
      boletoId: boletoResponse.data.nsuCode,
      bankNumber: bankNumber,
      workspaceId: workspaceId,
      data: boletoResponse.data
    });

  } catch (error) {
    console.error("❌ Erro no fluxo Santander:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack
    });

    const statusCode = error.response?.status || 500;
    const errorDetails = error.response?.data || error.message;

    res.status(statusCode).json({
      error: 'Falha no processo Santander',
      details: errorDetails,
      step: 'registro_boleto',
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================
// ROTA: BAIXAR PDF DO BOLETO
// =============================================
app.post('/api/santander/boletos/pdf', async (req, res) => {
  console.log("📥 Recebendo requisição para baixar PDF do boleto...");

  const { digitableLine, payerDocumentNumber } = req.body;
  if (!digitableLine || !payerDocumentNumber) {
    return res.status(400).json({
      error: "Dados incompletos",
      details: "É necessário informar 'digitableLine' e 'payerDocumentNumber'"
    });
  }

  try {
    const accessToken = await obterTokenSantander();
    const httpsAgent = createHttpsAgent();

    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }

    // Monta a URL substituindo {digitableLine}
    const url = `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`;

    const payload = {
      payerDocumentNumber: payerDocumentNumber.toString()
    };

    console.log("➡️ Payload PDF:", JSON.stringify(payload, null, 2));
    console.log("➡️ URL:", url);

    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "X-Application-Key": SANTANDER_CONFIG.CLIENT_ID,
        "Accept": "application/json"
      },
      httpsAgent,
      timeout: 30000
    });

    // Extrai o link da resposta
    const link = response.data?.link || response.data?.url;

    if (!link) {
      console.error("⚠️ Nenhum link retornado pelo Santander:", response.data);
      return res.status(500).json({
        error: "Resposta do Santander não contém link do PDF",
        rawResponse: response.data
      });
    }

    console.log("✅ PDF gerado com sucesso! Link:", link);

    res.json({
      success: true,
      message: "PDF gerado com sucesso",
      link: link,
      digitableLine: digitableLine
    });

  } catch (error) {
    console.error("❌ Erro ao gerar PDF do boleto:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    res.status(500).json({
      error: "Falha ao gerar PDF do boleto",
      details: error.response?.data || error.message,
      step: "gerar_pdf",
      timestamp: new Date().toISOString()
    });
  }
});

// =============================================
// ROTA: CONSULTAR BOLETO
// =============================================
app.get('/api/santander/boletos/:nsuCode', async (req, res) => {
  const { nsuCode } = req.params;

  console.log(`📥 Consultando boleto com NSU: ${nsuCode}`);

  try {
    const accessToken = await obterTokenSantander();
    const httpsAgent = createHttpsAgent();

    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }

    const response = await axios.get(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bank_slips/${nsuCode}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Accept': 'application/json'
        },
        httpsAgent,
        timeout: 30000
      }
    );

    console.log("✅ Boleto consultado com sucesso");

    res.json({
      success: true,
      message: 'Boleto encontrado',
      data: response.data
    });

  } catch (error) {
    console.error("❌ Erro ao consultar boleto:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data
    });

    res.status(500).json({
      error: "Falha ao consultar boleto",
      details: error.response?.data || error.message,
      step: "consultar_boleto"
    });
  }
});

// =============================================
// MIDDLEWARE DE ERRO GLOBAL
// =============================================
app.use((error, req, res, next) => {
  console.error('💥 Erro não tratado:', error);
  res.status(500).json({
    error: 'Erro interno do servidor',
    message: error.message,
    timestamp: new Date().toISOString()
  });
});

// =============================================
// ROTA 404
// =============================================
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Rota não encontrada',
    path: req.originalUrl,
    method: req.method,
    timestamp: new Date().toISOString()
  });
});

// =============================================
// INICIALIZAÇÃO DO SERVIDOR
// =============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n====================================================');
  console.log('🚀 Servidor Mendes Connexions Backend');
  console.log('====================================================');
  console.log('📍 Porta:', PORT);
  console.log('🌍 Ambiente:', process.env.NODE_ENV || 'development');
  console.log('🏥 Health check: http://0.0.0.0:' + PORT + '/health');
  console.log('✅ Servidor rodando com sucesso!');
  console.log('====================================================\n');
});
