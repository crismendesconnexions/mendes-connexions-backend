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
const allowedOrigins = [
  'https://mendesconnexions.com.br',
  'https://www.mendesconnexions.com.br',
  'http://localhost:3000',
  'http://localhost:8080',
  'http://localhost:56179',
  'http://localhost:5000',
  'http://127.0.0.1:56179',
  'http://127.0.0.1:5000',
  'https://mendes-connexions.web.app',
  'https://mendes-connexions.firebaseapp.com'
];
const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true);
    }
    const isLocalhost = origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1');
    const isAllowedDomain = allowedOrigins.indexOf(origin) !== -1;
    if (isLocalhost || isAllowedDomain) {
      console.log('✅ CORS permitido para:', origin);
      callback(null, true);
    } else {
      console.log('🚫 Bloqueado pelo CORS:', origin);
      callback(new Error('Não permitido pelo CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin', 'X-Application-Key'],
  exposedHeaders: ['Content-Length', 'X-Requested-With'],
  optionsSuccessStatus: 200
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
// =============================================
// MIDDLEWARES GLOBAIS
// =============================================
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
// Middleware de log para debug
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`📥 ${req.method} ${req.path} | Origem: ${req.headers.origin || 'N/A'} | Status: ${res.statusCode} | ${duration}ms`);
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
    if (!admin.apps.length) {
      return res.status(500).json({
        error: 'Serviço de autenticação indisponível',
        details: 'Firebase Admin não inicializado'
      });
    }
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
// ROTAS DE DIAGNÓSTICO
// =============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Backend online e funcionando',
    timestamp: new Date().toISOString(),
    service: 'Mendes Connexions Backend',
    environment: process.env.NODE_ENV || 'development',
    mode: process.env.USE_MOCK === 'true' ? 'MOCK' : 'REAL',
    firebase: !!admin.apps.length
  });
});
app.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Backend está funcionando!',
    timestamp: new Date().toISOString(),
    mode: process.env.USE_MOCK === 'true' ? 'MOCK' : 'REAL'
  });
});
app.get('/api/debug-env', (req, res) => {
  const cert = process.env.SANTANDER_CERTIFICATE_CRT_B64 || '';
  const key = process.env.SANTANDER_PRIVATE_KEY_B64 || '';
  res.json({
    hasCert: !!cert,
    hasKey: !!key,
    certLength: cert.length,
    keyLength: key.length,
    mode: process.env.USE_MOCK === 'true' ? 'MOCK' : 'REAL'
  });
});
// =============================================
// AGENTE HTTPS SANTANDER
// =============================================
function createHttpsAgent() {
  try {
    let certRaw = process.env.SANTANDER_CERTIFICATE_CRT_B64;
    let keyRaw = process.env.SANTANDER_PRIVATE_KEY_B64;
    const passphrase = process.env.SANTANDER_CERT_PASSWORD || undefined;
    if (!certRaw || !keyRaw) {
      console.error('❌ [MTLS] Faltam variáveis de ambiente para certificado');
      return null;
    }
    const cleanPEM = (raw) => {
      if (raw.includes('-----BEGIN')) {
        return raw.replace(/\\n/g, '\n');
      }
      try {
        const decoded = Buffer.from(raw, 'base64').toString('utf-8');
        const pemMatch = decoded.match(/-----BEGIN[^-]+-----[\s\S]+?-----END[^-]+-----/);
        if (pemMatch) {
          return pemMatch[0].replace(/\\n/g, '\n');
        }
        return decoded.replace(/\\n/g, '\n');
      } catch (e) {
        console.error('❌ Erro ao decodificar Base64:', e.message);
        return raw;
      }
    };
    const cert = cleanPEM(certRaw);
    const key = cleanPEM(keyRaw);
    console.log('✅ Certificado carregado');
    console.log('✅ Chave carregada');
    const agentOptions = {
      cert: cert,
      key: key,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.2',
      ciphers: 'DEFAULT:@SECLEVEL=0'
    };
    if (passphrase) {
      agentOptions.passphrase = passphrase;
    }
    return new https.Agent(agentOptions);
  } catch (error) {
    console.error('❌ [MTLS] Erro ao criar Agente:', error.message);
    return null;
  }
}
// =============================================
// FUNÇÕES DE DATA
// =============================================
function formatarDataParaSantander(date) {
  const dataSP = new Date(date.toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const ano = dataSP.getFullYear();
  const mes = String(dataSP.getMonth() + 1).padStart(2, '0');
  const dia = String(dataSP.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}
function calcularCincoDiasUteis() {
  const hoje = new Date();
  let data = new Date(hoje);
  let diasUteis = 0;
  while (diasUteis < 5) {
    data.setDate(data.getDate() + 1);
    const diaSemana = data.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) {
      diasUteis++;
    }
  }
  return formatarDataParaSantander(data);
}
function gerarDataAtual() {
  return formatarDataParaSantander(new Date());
}
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
    console.log('📋 Dados do lojista:', {
      clientNumber,
      nome: data.nomeFantasia || data.nome
    });
    return clientNumber?.toString() || null;
  } catch (error) {
    console.error('💥 Erro ao buscar clientNumber:', error);
    return null;
  }
}
// =============================================
// FUNÇÃO: OBTER TOKEN SANTANDER
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
    if (!httpsAgent) throw new Error('Agente HTTPS não pôde ser criado');
    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'MendesConnexions/1.0'
        },
        httpsAgent,
        timeout: 30000
      }
    );
    console.log("✅ Token recebido com sucesso");
    return response.data.access_token;
  } catch (err) {
    console.error("❌ Erro ao obter token:", err.message);
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
    covenants: [{ code: SANTANDER_CONFIG.COVENANT_CODE }]
  };
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
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID
        },
        httpsAgent,
        timeout: 30000
      }
    );
    console.log("✅ Workspace criada:", response.data.id);
    return response.data.id;
  } catch (error) {
    console.error("❌ Erro ao criar workspace:", error.message);
    throw error;
  }
}
// =============================================
// FUNÇÃO: GERAR NSU
// =============================================
async function gerarNSU(clientNumber) {
  const agoraSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const YY = String(agoraSP.getFullYear()).slice(-2);
  const MM = String(agoraSP.getMonth() + 1).padStart(2, '0');
  const DD = String(agoraSP.getDate()).padStart(2, '0');
  const HH = String(agoraSP.getHours()).padStart(2, '0');
  const min = String(agoraSP.getMinutes()).padStart(2, '0');
  const SS = String(agoraSP.getSeconds()).padStart(2, '0');
  if (!db) {
    return `${YY}${MM}${DD}${HH}${min}${SS}001`;
  }
  try {
    const ref = db.collection('config').doc('ultimoNSU');
    const doc = await ref.get();
    let ultimoSequencial = 0;
    if (doc.exists && doc.data()?.sequencial) {
      ultimoSequencial = parseInt(doc.data().sequencial);
    }
    const novoSequencial = (ultimoSequencial + 1) % 1000;
    await ref.set({ sequencial: novoSequencial });
    const sequencialStr = String(novoSequencial).padStart(3, '0');
    const nsu = `${YY}${MM}${DD}${HH}${min}${SS}${sequencialStr}`;
    console.log(`🔢 NSU gerado: ${nsu}`);
    return nsu;
  } catch (error) {
    console.error('❌ Erro ao gerar NSU:', error);
    return `${YY}${MM}${DD}${HH}${min}${SS}${String(clientNumber).slice(-3).padStart(3, '0')}`;
  }
}
// =============================================
// FUNÇÃO: GERAR BANK NUMBER
// =============================================
function gerarBankNumber(nsuCode, clientNumber) {
  const ultimos4 = nsuCode.slice(-4);
  const clientPadded = String(clientNumber).padStart(3, '0');
  return `${ultimos4}${clientPadded}`;
}
// =============================================
// ROTA: REGISTRAR BOLETO
// =============================================
app.post('/api/santander/boletos', async (req, res) => {
  console.log("📥 Recebendo requisição para gerar boleto...");
  const { dadosBoleto, lojistaId } = req.body;
  if (!dadosBoleto || !lojistaId) {
    return res.status(400).json({
      error: 'Dados do boleto ou ID do lojista não fornecidos'
    });
  }
  try {
    const clientNumber = await buscarClientNumber(lojistaId);
    if (!clientNumber) {
      return res.status(400).json({
        error: 'ClientNumber do lojista não encontrado'
      });
    }
    const accessToken = await obterTokenSantander();
    const workspaceId = await criarWorkspace(accessToken);
    const nsuCode = await gerarNSU(clientNumber);
    const bankNumber = gerarBankNumber(nsuCode, clientNumber);
    // Vencimento: usa o informado (YYYY-MM-DD, ex.: mensalidades) ou 5 dias úteis.
    const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(dadosBoleto.dueDate || '')
      ? dadosBoleto.dueDate
      : calcularCincoDiasUteis();
    const nsuDate = gerarDataAtual();
    const issueDate = gerarDataAtual();
    // O Santander recusa acento, cedilha e caractere de controle nos campos
    // do pagador. "ENDEREÇO NÃO INFORMADO" (que o app manda como fallback)
    // chegava com acento e derrubava o registro.
    // normalize('NFD') separa a letra do acento ("Ç" vira "C" + cedilha);
    // o filtro seguinte descarta tudo que não for ASCII simples, então o
    // acento cai e a letra permanece.
    const soASCII = (txt, tamanho) => String(txt || '')
      .normalize('NFD')
      .replace(/[^A-Za-z0-9 .,\-\/]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase()
      .substring(0, tamanho);

    const docPagador = String(dadosBoleto.pagadorDocumento || '').replace(/[^0-9]/g, '');
    // CPF tem 11 dígitos, CNPJ tem 14. Mandar o tipo errado é recusa na hora.
    const tipoDocPagador = docPagador.length === 11 ? "CPF" : "CNPJ";

    // CEP zerado é inválido. Sem CEP de verdade, usa um CEP existente para o
    // registro não morrer — o endereço não afeta a cobrança em si.
    let cepPagador = String(dadosBoleto.pagadorCEP || '').replace(/[^0-9]/g, '');
    if (cepPagador.length !== 8 || cepPagador === '00000000') cepPagador = '01310100';

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
        name: soASCII(dadosBoleto.pagadorNome || "LOJISTA", 40),
        documentType: tipoDocPagador,
        documentNumber: docPagador || "00000000000000",
        address: soASCII(dadosBoleto.pagadorEndereco || "ENDERECO NAO INFORMADO", 40),
        neighborhood: soASCII(dadosBoleto.bairro || "CENTRO", 20),
        city: soASCII(dadosBoleto.pagadorCidade || "SAO PAULO", 20),
        state: soASCII(dadosBoleto.pagadorEstado || "SP", 2),
        zipCode: `${cepPagador.slice(0, 5)}-${cepPagador.slice(5)}`
      },
      documentKind: "DUPLICATA_MERCANTIL",
      deductionValue: "0.00",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      messages: ["Boleto gerado via Mendes Connexions"],
      // (multa/juros/protesto/baixa aplicados abaixo a partir da config)
      key: {
        type: "CNPJ",
        dictKey: SANTANDER_CONFIG.DICT_KEY.replace(/[^0-9]/g, '')
      }
    };

    // ── Configuração de cobrança (multa/juros/protesto/prazo) ──────────────
    // São dois perfis, escolhidos por dadosBoleto.tipoCobranca:
    //   'pontuacao' -> configuracoes/boletosPontuacao
    //   qualquer outro (ou ausente) -> configuracoes/boletos (financeiro)
    // Se o doc de pontuação não existir, cai no do financeiro para não
    // emitir boleto sem regra nenhuma.
    try {
      if (db) {
        const ehPontuacao = String(dadosBoleto.tipoCobranca || '') === 'pontuacao';
        const docCfg = ehPontuacao ? 'boletosPontuacao' : 'boletos';
        let cfgSnap = await db.collection('configuracoes').doc(docCfg).get();
        if (!cfgSnap.exists && ehPontuacao) {
          cfgSnap = await db.collection('configuracoes').doc('boletos').get();
        }
        const cfg = cfgSnap.exists ? cfgSnap.data() : {};
        const multa = Number(cfg.multaPercent) || 0;      // %
        const juros = Number(cfg.jurosPercentMes) || 0;   // % ao mês
        const baixaDias = Number(cfg.baixaDias) || 30;    // dias até baixa
        payload.writeOffQuantityDays = String(baixaDias);
        if (multa > 0) payload.finePercentage = multa.toFixed(2);
        if (juros > 0) payload.interestPercentage = juros.toFixed(2);
        // Protesto com prazo zero é instrução inválida — o banco recusa o
        // título inteiro. Só manda a instrução se houver prazo de verdade.
        const protestoDias = Number(cfg.protestoDias) || 0;
        if (cfg.protestar === true && protestoDias > 0) {
          payload.protestType = "CLEAN";
          payload.protestQuantityDays = String(protestoDias);
          // A baixa não pode acontecer antes do protesto, senão as duas
          // instruções se contradizem.
          if (baixaDias <= protestoDias) {
            payload.writeOffQuantityDays = String(protestoDias + 30);
            console.warn(`⚠️ Baixa (${baixaDias}d) <= protesto (${protestoDias}d) — ajustada para ${protestoDias + 30}d`);
          }
        } else if (cfg.protestar === true) {
          console.warn('⚠️ Protesto ligado mas sem prazo em dias — instrução ignorada');
        }
        console.log(`⚙️ Config cobrança (${docCfg}): multa=${multa}% juros=${juros}% baixa=${baixaDias}d protesto=${cfg.protestar === true}`);
      }
    } catch (cfgErr) {
      console.warn('⚠️ Não foi possível ler config de cobrança:', cfgErr.message);
    }

    console.log("📦 Enviando para Santander...");
    // Payload completo no log: quando vem 400, é comparando o que foi enviado
    // com o campo que o banco aponta que se acha o erro.
    console.log("📤 Payload:", JSON.stringify(payload));
    const httpsAgent = createHttpsAgent();
    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }
    const boletoResponse = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
          'Authorization': `Bearer ${accessToken}`
        },
        httpsAgent,
        timeout: 30000
      }
    );
    console.log("✅ Boleto registrado com sucesso!");
    console.log("📦 Resposta Santander (criação):", JSON.stringify(boletoResponse.data, null, 2));

    const nsuRetornado   = boletoResponse.data.nsuCode || nsuCode;
    const txId           = boletoResponse.data.txId || null;
    // Nosso Número definitivo retornado pelo Santander (pode diferir do que enviamos)
    // Usar o retornado pela API como fonte de verdade para operações PATCH/GET
    const bankNumberFinal = boletoResponse.data.bankNumber || bankNumber || null;
    const covenantCode   = boletoResponse.data.covenantCode || SANTANDER_CONFIG.COVENANT_CODE || '178622';

    // Persistir workspaceId + bankNumber + covenantCode no Firestore para operações futuras
    // bankNumber + covenantCode são os campos usados para PATCH (baixar) e GET (bills)
    if (db && workspaceId && nsuRetornado) {
      try {
        await db.collection('santanderWorkspaces').doc(nsuRetornado).set({
          workspaceId:   workspaceId,
          nsuCode:       nsuRetornado,
          txId:          txId,
          bankNumber:    bankNumberFinal,
          covenantCode:  covenantCode,
          lojistaId:     lojistaId,
          criadoEm:      new Date().toISOString()
        });
        console.log(`💾 Dados salvos para NSU ${nsuRetornado}:`);
        console.log(`   workspaceId: ${workspaceId}`);
        console.log(`   bankNumber: ${bankNumberFinal}`);
        console.log(`   covenantCode: ${covenantCode}`);
      } catch (fsErr) {
        console.warn('⚠️ Não foi possível salvar no Firestore:', fsErr.message);
      }
    }

    res.json({
      success: true,
      message: 'Boleto registrado com sucesso',
      boletoId: nsuRetornado,
      workspaceId: workspaceId,
      bankNumber: bankNumberFinal,
      covenantCode: covenantCode,
      txId: txId,
      digitableLine: boletoResponse.data.digitableLine,
      data: boletoResponse.data
    });
  } catch (error) {
    // error.message só diz "Request failed with status code 400". O motivo de
    // verdade — qual campo o banco recusou — vem em error.response.data, que
    // antes era descartado. Sem isso não dá para saber o que corrigir.
    const santander = error.response?.data;
    const httpStatus = error.response?.status;
    console.error("❌ Erro no fluxo Santander:", error.message);
    if (santander) {
      console.error(`❌ Resposta do banco (${httpStatus}):`, JSON.stringify(santander));
    }
    res.status(500).json({
      error: 'Falha no processo Santander',
      details: error.message,
      santanderStatus: httpStatus || null,
      santanderErro: santander || null,
      step: 'registro_boleto',
      timestamp: new Date().toISOString()
    });
  }
});
// =============================================
// ROTA: CONSULTAR STATUS DO BOLETO
// =============================================
app.get('/api/santander/boletos/:nsuCode', async (req, res) => {
  const { nsuCode } = req.params;
  console.log(`📥 Consultando boleto NSU: ${nsuCode}`);

  // Validação: NSU deve ser numérico
  if (!nsuCode || !/^\d+$/.test(nsuCode)) {
    return res.status(400).json({
      error: 'NSU inválido',
      details: 'O NSU deve conter apenas dígitos numéricos',
      nsuRecebido: nsuCode
    });
  }

  try {
    const accessToken = await obterTokenSantander();
    const httpsAgent = createHttpsAgent();

    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }

    // ── 1. Buscar workspaceId salvo no Firestore ───────────────────────────
    let workspaceId = null;

    if (db) {
      // Tenta na coleção santanderWorkspaces (salva na criação)
      try {
        const wsDoc = await db.collection('santanderWorkspaces').doc(nsuCode).get();
        if (wsDoc.exists) {
          workspaceId = wsDoc.data().workspaceId;
          console.log(`✅ workspaceId encontrado no Firestore: ${workspaceId}`);
        }
      } catch (e) {
        console.warn('⚠️ Erro ao buscar santanderWorkspaces:', e.message);
      }

      // Fallback: busca na coleção boletos pelo campo nsu ou boletoId
      if (!workspaceId) {
        try {
          let boletosSnap = await db.collection('boletos')
            .where('nsu', '==', nsuCode).limit(1).get();
          if (boletosSnap.empty) {
            boletosSnap = await db.collection('boletos')
              .where('boletoId', '==', nsuCode).limit(1).get();
          }
          if (!boletosSnap.empty) {
            const bd = boletosSnap.docs[0].data();
            workspaceId = bd.workspaceId || bd.santanderWorkspaceId || null;
            if (workspaceId) {
              console.log(`✅ workspaceId encontrado em boletos: ${workspaceId}`);
            }
          }
        } catch (e) {
          console.warn('⚠️ Erro ao buscar boletos por NSU:', e.message);
        }
      }
    }

    // ── 2. Buscar também o ID interno do Santander (salvo na criação) ─────
    let santanderInternalId = null;
    if (db) {
      try {
        const wsDoc = await db.collection('santanderWorkspaces').doc(nsuCode).get();
        if (wsDoc.exists) {
          const wsData = wsDoc.data();
          workspaceId = workspaceId || wsData.workspaceId;
          santanderInternalId = wsData.santanderInternalId || null;
        }
      } catch (e) { /* já logado acima */ }
    }

    // ── 3. Se ainda não tem workspaceId, cria um novo como fallback ───────
    if (!workspaceId) {
      console.log('⚠️ workspaceId não encontrado — criando novo workspace como fallback');
      workspaceId = await criarWorkspace(accessToken);
    }

    const baseUrl = `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`;
    const headers = {
      'Authorization': `Bearer ${accessToken}`,
      'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
      'Accept': 'application/json'
    };

    let response;

    // ── Busca bankNumber e covenantCode no Firestore (salvos na criação) ─────
    let bankNumber   = null;
    let covenantCode = SANTANDER_CONFIG.COVENANT_CODE || '178622';
    if (db) {
      try {
        const wsDoc = await db.collection('santanderWorkspaces').doc(nsuCode).get();
        if (wsDoc.exists) {
          bankNumber   = wsDoc.data().bankNumber   || null;
          covenantCode = wsDoc.data().covenantCode || covenantCode;
          workspaceId  = workspaceId || wsDoc.data().workspaceId || null;
        }
      } catch (e) { /* não crítico */ }
    }

    // ── 4a. GET via endpoint /bills com bankNumber (mais confiável) ───────────
    // /bills retorna uma lista (array ou { content: [...] }) — extrai o primeiro item
    if (bankNumber) {
      const billsUrl = `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills`;
      console.log(`➡️ GET /bills | bankNumber=${bankNumber} | covenantCode=${covenantCode}`);
      try {
        const billResp = await axios.get(billsUrl, {
          headers, httpsAgent, timeout: 30000,
          params: { beneficiaryCode: covenantCode, bankNumber }
        });

        // Normaliza o formato da resposta: array direto OU { content: [...] }
        const raw = billResp.data;
        let boleto = null;
        if (Array.isArray(raw) && raw.length > 0) {
          boleto = raw[0];
        } else if (raw && Array.isArray(raw.content) && raw.content.length > 0) {
          boleto = raw.content[0];
        } else if (raw && typeof raw === 'object' && raw.situation) {
          // Resposta já é um objeto único
          boleto = raw;
        }

        if (boleto) {
          console.log(`✅ Boleto encontrado via /bills. Situação: ${boleto.situation} | Status: ${boleto.status}`);
          // Substitui data da resposta pelo objeto normalizado (único boleto)
          response = { ...billResp, data: boleto };
        } else {
          console.warn(`⚠️ GET /bills retornou lista vazia para bankNumber=${bankNumber}`);
          console.log(`   Resposta bruta: ${JSON.stringify(raw).substring(0, 300)}`);
          response = null;
        }
      } catch (e) {
        console.warn(`⚠️ GET /bills falhou (${e.response?.status}):`, JSON.stringify(e.response?.data));
        response = null;
      }
    }

    // ── 4b. Fallback: GET SONDA pelo nsuCode no path ──────────────────────────
    if (!response && workspaceId) {
      const urlByNsu = `${baseUrl}/${nsuCode}`;
      console.log(`➡️ GET SONDA por NSU: ${urlByNsu}`);
      try {
        response = await axios.get(urlByNsu, { headers, httpsAgent, timeout: 30000 });
        console.log("✅ Boleto encontrado via SONDA. Situação:", response.data?.situation);
      } catch (e) {
        console.warn(`⚠️ GET SONDA falhou (${e.response?.status})`);
        response = null;
      }
    }

    // ── 4c. Sem bankNumber e sem workspaceId → não pode consultar ────────────
    if (!response) {
      console.warn(`⚠️ Boleto NSU ${nsuCode} não encontrado em nenhum endpoint`);
      return res.status(404).json({
        error: 'Boleto não encontrado no Santander',
        details: 'bankNumber não disponível ou workspace diferente. Use "Registrar auto" para re-registrar.',
        nsuCode,
        hint: 'RE_REGISTRAR'
      });
    }

    res.json({
      success: true,
      message: 'Boleto encontrado',
      data: response.data
    });

  } catch (error) {
    const httpStatus = error.response?.status;
    const errorData = error.response?.data;

    console.error("❌ Erro ao consultar boleto:", {
      nsuCode,
      httpStatus,
      message: error.message,
      data: errorData
    });

    if (httpStatus === 404) {
      return res.status(404).json({
        error: 'Boleto não encontrado no Santander',
        details: errorData || 'NSU não registrado ou expirado',
        nsuCode
      });
    }

    res.status(500).json({
      error: 'Falha ao consultar boleto',
      details: errorData || error.message,
      nsuCode,
      step: 'consultar_boleto'
    });
  }
});
// =============================================
// ROTA: CANCELAR BOLETO NO SANTANDER
// =============================================
app.delete('/api/santander/boletos/:nsuCode', authenticateFirebase, async (req, res) => {
  const { nsuCode } = req.params;
  console.log(`🗑 Cancelando boleto NSU: ${nsuCode}`);

  if (!nsuCode || !/^\d+$/.test(nsuCode)) {
    return res.status(400).json({ error: 'NSU inválido', nsuCode });
  }

  try {
    const accessToken = await obterTokenSantander();
    const httpsAgent  = createHttpsAgent();
    if (!httpsAgent) throw new Error('Agente HTTPS não disponível');

    // Busca workspaceId + bankNumber + covenantCode no Firestore (salvos na criação)
    let workspaceId  = null;
    let bankNumber   = null;
    let covenantCode = SANTANDER_CONFIG.COVENANT_CODE || '178622';

    if (db) {
      try {
        const wsDoc = await db.collection('santanderWorkspaces').doc(nsuCode).get();
        if (wsDoc.exists) {
          const d    = wsDoc.data();
          workspaceId  = d.workspaceId  || null;
          bankNumber   = d.bankNumber   || null;
          covenantCode = d.covenantCode || covenantCode;
        }
      } catch (e) {
        console.warn('⚠️ Erro ao buscar santanderWorkspaces:', e.message);
      }

      // Fallback: busca no doc de boleto
      if (!workspaceId || !bankNumber) {
        try {
          let snap = await db.collection('boletos').where('nsu', '==', nsuCode).limit(1).get();
          if (snap.empty) snap = await db.collection('boletos').where('boletoId', '==', nsuCode).limit(1).get();
          if (!snap.empty) {
            const bd = snap.docs[0].data();
            workspaceId  = workspaceId  || bd.workspaceId || bd.santanderWorkspaceId || null;
            bankNumber   = bankNumber   || bd.bankNumber  || null;
            covenantCode = covenantCode || bd.santanderResponse?.covenantCode || '178622';
          }
        } catch (e) {
          console.warn('⚠️ Erro ao buscar boleto:', e.message);
        }
      }
    }

    console.log(`🔍 Dados para cancelamento:`, { workspaceId, bankNumber, covenantCode, nsuCode });

    if (!workspaceId) {
      console.warn(`⚠️ workspaceId não encontrado para NSU ${nsuCode} — cancelamento local apenas`);
      return res.json({
        success: true,
        message: 'Boleto sem workspace registrado — cancelado apenas localmente.',
        localOnly: true
      });
    }

    if (!bankNumber) {
      console.warn(`⚠️ bankNumber não encontrado para NSU ${nsuCode} — cancelamento local apenas`);
      return res.json({
        success: true,
        message: 'bankNumber não disponível para este boleto — cancele manualmente no portal Santander.',
        localOnly: true,
        workspaceId,
        nsuCode
      });
    }

    const headers = {
      'Authorization':     `Bearer ${accessToken}`,
      'X-Application-Key': SANTANDER_CONFIG.CLIENT_ID,
      'Content-Type':      'application/json',
      'Accept':            'application/json'
    };
    const opts = { headers, httpsAgent, timeout: 30000 };

    // ── Conforme documentação Santander API v2.1 ────────────────────────────
    // BAIXAR = PATCH na URL BASE /bank_slips (sem ID no path)
    // O boleto é identificado pelo covenantCode + bankNumber no body
    // Ref: "6.2 BANK SLIP | Comando de Instruções | PATCH"
    const urlPatch = `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`;
    const baixarBody = {
      covenantCode: covenantCode,
      bankNumber:   bankNumber,
      operation:    'BAIXAR'
    };

    let cancelado = false;

    try {
      console.log(`➡️ PATCH ${urlPatch} | body:`, JSON.stringify(baixarBody));
      await axios.patch(urlPatch, baixarBody, opts);
      cancelado = true;
      console.log(`✅ Boleto ${nsuCode} baixado via PATCH (operation=BAIXAR)`);
    } catch (patchErr) {
      const st = patchErr.response?.status;
      const dt = patchErr.response?.data;
      console.warn(`⚠️ PATCH BAIXAR falhou (${st}):`, JSON.stringify(dt));

      if (st !== 404 && st !== 400) {
        // Tenta PUT como alternativa
        try {
          console.log(`➡️ PUT ${urlPatch}`);
          await axios.put(urlPatch, baixarBody, opts);
          cancelado = true;
          console.log(`✅ Boleto ${nsuCode} baixado via PUT`);
        } catch (putErr) {
          console.warn(`⚠️ PUT também falhou (${putErr.response?.status}):`, JSON.stringify(putErr.response?.data));
        }
      }
    }

    if (!cancelado) {
      console.warn(`⚠️ Não foi possível cancelar ${nsuCode} via API — retornando localOnly`);
      return res.json({
        success: true,
        message: 'Não foi possível cancelar via API Santander. Cancele manualmente no portal usando o bankNumber: ' + bankNumber,
        localOnly: true,
        workspaceId,
        bankNumber,
        nsuCode
      });
    }

    console.log(`✅ Boleto ${nsuCode} cancelado no Santander (cancelado=${cancelado})`);

    // Remove entrada da coleção santanderWorkspaces
    if (db) {
      try {
        await db.collection('santanderWorkspaces').doc(nsuCode).delete();
      } catch (e) { /* não crítico */ }
    }

    res.json({ success: true, message: `Boleto ${nsuCode} cancelado com sucesso.` });

  } catch (error) {
    const httpStatus = error.response?.status;
    const errorData  = error.response?.data;
    console.error('❌ Erro ao cancelar boleto:', { nsuCode, httpStatus, data: errorData });

    // 404 do Santander = boleto já cancelado ou não existe
    if (httpStatus === 404) {
      return res.json({
        success: true,
        message: 'Boleto não encontrado no Santander (já cancelado ou expirado).',
        alreadyCancelled: true
      });
    }

    res.status(500).json({
      error:   'Falha ao cancelar boleto no Santander',
      details: errorData || error.message,
      nsuCode
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
      error: "Dados incompletos"
    });
  }
  try {
    const accessToken = await obterTokenSantander();
    const httpsAgent = createHttpsAgent();
    if (!httpsAgent) {
      throw new Error('Agente HTTPS não disponível');
    }
    const url = `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`;
    const payload = {
      payerDocumentNumber: payerDocumentNumber.toString().replace(/[^0-9]/g, '')
    };
    const response = await axios.post(url, payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "X-Application-Key": SANTANDER_CONFIG.CLIENT_ID
      },
      httpsAgent,
      timeout: 30000
    });
    const link = response.data?.link || response.data?.url;
    if (!link) {
      throw new Error('Link do PDF não encontrado');
    }
    console.log("✅ PDF gerado com sucesso!");
    res.json({
      success: true,
      link: link,
      digitableLine: digitableLine
    });
  } catch (error) {
    console.error("❌ Erro ao gerar PDF:", error.message);
    res.status(500).json({
      error: "Falha ao gerar PDF do boleto",
      details: error.message
    });
  }
});
// =============================================
// ROTA: UPLOAD PARA CLOUDINARY
// =============================================
app.post('/api/cloudinary/upload-pdf', authenticateFirebase, async (req, res) => {
  try {
    const { pdfUrl, fileName, boletoId } = req.body;
    console.log('☁️ Iniciando upload para Cloudinary...');
    if (!pdfUrl || !fileName) {
      return res.status(400).json({
        error: 'Dados incompletos'
      });
    }
    const pdfResponse = await fetch(pdfUrl);
    if (!pdfResponse.ok) {
      throw new Error(`Erro ao baixar PDF: ${pdfResponse.status}`);
    }
    const pdfBlob = await pdfResponse.blob();
    console.log(`✅ PDF baixado: ${pdfBlob.size} bytes`);
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
      throw new Error(errorData.error?.message || 'Erro no upload');
    }
    const cloudinaryData = await cloudinaryResponse.json();
    console.log('✅ Upload Cloudinary realizado:', cloudinaryData.secure_url);
    if (boletoId && db) {
      await db.collection('boletos').doc(boletoId).update({
        boletoViewUrl: cloudinaryData.secure_url,
        boletoPublicId: cloudinaryData.public_id,
        boletoUploadedAt: new Date().toISOString()
      });
    }
    res.json({
      success: true,
      cloudinaryUrl: cloudinaryData.secure_url,
      publicId: cloudinaryData.public_id
    });
  } catch (error) {
    console.error('❌ Erro no upload:', error.message);
    res.status(500).json({
      error: 'Erro ao fazer upload: ' + error.message
    });
  }
});
// =============================================
// ROTA: DOWNLOAD DIRETO DO PDF
// =============================================
app.get('/api/cloudinary/download-pdf', authenticateFirebase, async (req, res) => {
  try {
    const { publicId, fileName = 'boleto.pdf' } = req.query;
    if (!publicId) {
      return res.status(400).json({ error: 'publicId é obrigatório' });
    }
    const downloadUrl = `https://res.cloudinary.com/dno43pc3o/raw/upload/fl_attachment:${fileName}/${publicId}`;
    const response = await fetch(downloadUrl);
    if (!response.ok) {
      throw new Error(`Erro ao baixar PDF: ${response.status}`);
    }
    const pdfBuffer = await response.buffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('❌ Erro no download:', error.message);
    res.status(500).json({ error: 'Erro ao baixar PDF: ' + error.message });
  }
});
// =============================================
// WEBHOOK: NOTIFICAÇÃO DE PAGAMENTO
// =============================================
// O Santander (ou um job de conciliação) chama esta rota quando um boleto é
// pago. Damos baixa automática: marcamos o boleto como pago nas coleções
// (boletos e boletos_mensalidade), refletimos nas pontuações e lançamos a
// entrada no financeiro (regime de caixa).
//
// Corpo aceito (flexível):
//   { nsuCode | nsu | bankNumber, status?, paymentDate?, paymentAmount? }
// Protegido por chave: header 'x-webhook-secret' ou ?secret= (mendes2024).
function isPagoSituation(s) {
  const v = String(s || '').toUpperCase();
  return ['LIQUIDATED', 'LIQUIDADO', 'PAGO', 'BAIXADO', 'SETTLED', 'PAID'].includes(v);
}

async function darBaixaPorNsu(nsuCode, info = {}) {
  if (!db) throw new Error('Firestore indisponível');
  const dataPag = info.paymentDate ? new Date(info.paymentDate) : new Date();
  const resultados = [];

  // Procura nas duas coleções, por vários campos de NSU.
  const colecoes = ['boletos_mensalidade', 'boletos'];
  for (const col of colecoes) {
    const campos = ['boletoNsuCode', 'nsu', 'boletoId'];
    let achou = null;
    for (const campo of campos) {
      const snap = await db.collection(col).where(campo, '==', String(nsuCode)).limit(1).get();
      if (!snap.empty) { achou = snap.docs[0]; break; }
    }
    if (!achou) continue;

    const b = achou.data();
    if (b.status === 'pago') { resultados.push(`${col}: já estava pago`); continue; }

    await achou.ref.update({
      status: 'pago',
      dataPagamento: admin.firestore.Timestamp.fromDate(dataPag),
      pagoViaWebhook: true,
    });

    // Lançamento de entrada (regime de caixa)
    const origem = col === 'boletos' ? 'Pontuação' : 'Mensalidade';
    const valor = b.valor || b.valorBoleto || info.paymentAmount || 0;
    await db.collection('financeiro_lancamentos').add({
      tipo: 'entrada',
      categoria: origem,
      descricao: `${origem} - ${b.lojistaNome || ''}${b.competencia ? ` (${b.competencia})` : ''}`,
      valor: Number(valor),
      data: admin.firestore.Timestamp.fromDate(dataPag),
      boletoId: achou.id,
      boletoColecao: col,
      origem,
      criadoEm: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Reflete nas pontuações vinculadas (quando for boleto de pontuação)
    if (col === 'boletos') {
      try {
        const pts = await db.collection('pontuacoes').where('boletoNsuCode', '==', String(nsuCode)).get();
        const batch = db.batch();
        pts.forEach((p) => batch.update(p.ref, {
          status: 'realizado',
          statusBoleto: 'pago',
          dataPagamento: admin.firestore.Timestamp.fromDate(dataPag),
          pagoViaWebhook: true,
        }));
        await batch.commit();
      } catch (e) {
        console.warn('⚠️ Falha ao atualizar pontuações:', e.message);
      }
    }
    resultados.push(`${col}: baixado`);
  }
  return resultados;
}

app.post('/api/santander/webhook', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

  const secret = req.headers['x-webhook-secret'] || req.query.secret;
  if (secret !== 'mendes2024') {
    return res.status(401).json({ success: false, error: 'Chave inválida' });
  }

  try {
    const body = req.body || {};
    const nsuCode = body.nsuCode || body.nsu || body.bankNumber ||
      (body.data && (body.data.nsuCode || body.data.nsu));
    const situation = body.status || body.situation ||
      (body.data && (body.data.situation || body.data.status));

    if (!nsuCode) {
      return res.status(400).json({ success: false, error: 'nsuCode não informado' });
    }
    // Se veio status e NÃO é pago, apenas registra e sai.
    if (situation && !isPagoSituation(situation)) {
      console.log(`ℹ️ Webhook NSU ${nsuCode} status ${situation} (ignorado, não é pago)`);
      return res.json({ success: true, ignored: true, situation });
    }

    const resultados = await darBaixaPorNsu(nsuCode, {
      paymentDate: body.paymentDate || (body.data && body.data.paymentDate),
      paymentAmount: body.paymentAmount || (body.data && body.data.paymentAmount),
    });
    console.log(`✅ Webhook baixa NSU ${nsuCode}:`, resultados);
    res.json({ success: true, nsuCode, resultados });
  } catch (error) {
    console.error('❌ Erro no webhook:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =============================================
// ROTA 404 CUSTOMIZADA
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
  console.log('✅ Modo REAL ativado');
  console.log('====================================================\n');
});
