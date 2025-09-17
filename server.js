const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Inicializar Firebase Admin SDK
const serviceAccount = require('./serviceAccountKey.json'); // Coloque seu arquivo de credenciais aqui

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// Credenciais Santander
const SANTANDER_CLIENT_ID = 'x3mcIb4NSPwYIQcfxRUA3SdjjhywtKfI';
const SANTANDER_CLIENT_SECRET = 'lrHiIZpKnGFGNcJF';
const SANTANDER_COVENANT_CODE = '178622';
const SANTANDER_PARTICIPANT_CODE = 'REGISTRO12';
const SANTANDER_DICT_KEY = '09199193000126';

// Variáveis globais
let accessToken = null;
let tokenExpiration = null;
let workspaceId = null;

// Função para verificar se o token está expirado
function isTokenExpired() {
  if (!tokenExpiration) return true;
  return Date.now() >= tokenExpiration;
}

// Função atualizada para obter token do Santander
async function obterTokenSantander() {
  try {
    // Verificar se já temos um token válido
    if (!isTokenExpired() && accessToken) {
      console.log('[Santander] Usando token existente');
      return accessToken;
    }

    console.log('[Santander] Solicitando novo token...');

    const auth = Buffer.from(`${SANTANDER_CLIENT_ID}:${SANTANDER_CLIENT_SECRET}`).toString('base64');

    const formData = new URLSearchParams();
    formData.append('grant_type', 'client_credentials');

    const response = await axios.post(
      'https://trust-open.api.santander.com.br/auth/oauth/v2/token',
      formData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${auth}`
        }
      }
    );

    accessToken = response.data.access_token;
    tokenExpiration = Date.now() + (response.data.expires_in * 1000) - 60000;

    console.log('[Santander] Token obtido com sucesso:', accessToken);
    console.log('[Santander] Expira em:', new Date(tokenExpiration).toLocaleString());

    return accessToken;
  } catch (error) {
    if (error.response) {
      console.error('[Santander] Erro ao obter token');
      console.error('Status:', error.response.status);
      console.error('Headers:', error.response.headers);
      console.error('Data:', error.response.data);
    } else {
      console.error('[Santander] Erro sem response:', error.message);
    }
    throw new Error('Falha ao obter token do Santander');
  }
}

// Função para listar workspaces existentes
async function listarWorkspaces() {
  try {
    const token = await obterTokenSantander();

    const response = await axios.get('https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/', {
      headers: {
        'Content-Type': 'application/json',
        'X-Application-Key': SANTANDER_CLIENT_ID,
        'Authorization': 'Bearer ' + token
      }
    });

    console.log('[Santander] Workspaces existentes:', response.data);

    if (response.data && response.data.length > 0) {
      for (let i = 0; i < response.data.length; i++) {
        const ws = response.data[i];
        if (ws.covenants) {
          for (let j = 0; j < ws.covenants.length; j++) {
            if (ws.covenants[j].code == SANTANDER_COVENANT_CODE) {
              workspaceId = ws.id;
              console.log('[Santander] Workspace existente encontrado:', workspaceId);
              return workspaceId;
            }
          }
        }
      }
    }

    return null;
  } catch (error) {
    console.error('[Santander] Erro ao listar workspaces:', error.response?.data || error.message);
    return null;
  }
}

// Função para criar workspace no Santander
async function criarWorkspaceSantander() {
  try {
    const token = await obterTokenSantander();

    const response = await axios.post('https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces', {
      type: 'BILLING',
      description: 'Workspace de Cobrança',
      covenants: [{ code: parseInt(SANTANDER_COVENANT_CODE) }]
    }, {
      headers: {
        'Content-Type': 'application/json',
        'X-Application-Key': SANTANDER_CLIENT_ID,
        'Authorization': 'Bearer ' + token
      }
    });

    workspaceId = response.data.id;
    console.log('[Santander] Workspace criado com sucesso:', workspaceId);
    return workspaceId;
  } catch (error) {
    console.error('[Santander] Erro ao criar workspace:', error.response?.data || error.message);
    throw error;
  }
}

// Função para obter ou criar workspace
async function obterWorkspaceId() {
  if (workspaceId) return workspaceId;

  const workspaceExistente = await listarWorkspaces();
  if (workspaceExistente) return workspaceExistente;

  return await criarWorkspaceSantander();
}

// Função para gerar número único para o boleto
function gerarNumeroUnico(clientNumber) {
  const now = new Date();
  const dia = String(now.getDate()).padStart(2, '0');
  const mes = String(now.getMonth() + 1).padStart(2, '0');
  const ano = String(now.getFullYear()).slice(-2);
  const hora = String(now.getHours()).padStart(2, '0');
  const minuto = String(now.getMinutes()).padStart(2, '0');
  const segundo = String(now.getSeconds()).padStart(2, '0');

  return dia + mes + ano + hora + minuto + segundo + String(clientNumber).padStart(5, '0');
}

// Função para gerar bankNumber sequencial
let ultimoBankNumber = 0;
function gerarBankNumberSequencial() {
  ultimoBankNumber++;
  return ultimoBankNumber.toString().padStart(6, '0');
}

// Função para registrar boleto no Santander
async function registrarBoletoSantander(dadosBoleto) {
  try {
    const token = await obterTokenSantander();
    workspaceId = await obterWorkspaceId();

    const nsuCode = gerarNumeroUnico(dadosBoleto.clientNumber);
    const bankNumber = gerarBankNumberSequencial();

    const hoje = new Date();
    let vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 1, 5);
    if (hoje.getDate() > 5) {
      vencimento = new Date(hoje.getFullYear(), hoje.getMonth() + 2, 5);
    }

    const dueDate = vencimento.toISOString().split('T')[0];
    const nsuDate = hoje.toISOString().split('T')[0];
    const issueDate = hoje.toISOString().split('T')[0];

    const valorBoleto = parseFloat(dadosBoleto.valor).toFixed(2);

    let zipCodeFormatado = dadosBoleto.pagadorCEP.replace(/\D/g, '');
    if (zipCodeFormatado.length === 8) {
      zipCodeFormatado = zipCodeFormatado.substring(0, 5) + '-' + zipCodeFormatado.substring(5);
    }

    const nomeSanitizado = dadosBoleto.pagadorNome
      .replace(/[^a-zA-Z0-9áàâãéèêíïóôõöúçñÁÀÂãÉÈÊÍÏÓÔÕÖÚÇÑ&\s]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, 40);

    const payload = {
      environment: 'PRODUCAO',
      nsuCode: nsuCode,
      nsuDate: nsuDate,
      covenantCode: parseInt(SANTANDER_COVENANT_CODE),
      bankNumber: bankNumber,
      clientNumber: dadosBoleto.clientNumber.toString().padStart(5, '0'),
      dueDate: dueDate,
      issueDate: issueDate,
      participantCode: SANTANDER_PARTICIPANT_CODE,
      nominalValue: valorBoleto,
      payer: {
        name: nomeSanitizado,
        documentType: "CNPJ",
        documentNumber: dadosBoleto.pagadorDocumento.replace(/\D/g, ''),
        address: dadosBoleto.pagadorEndereco,
        neighborhood: dadosBoleto.pagadorBairro,
        city: dadosBoleto.pagadorCidade,
        state: dadosBoleto.pagadorEstado,
        zipCode: zipCodeFormatado
      },
      documentKind: "DUPLICATA_MERCANTIL",
      deductionValue: "0.00",
      paymentType: "REGISTRO",
      writeOffQuantityDays: "30",
      messages: [
        "Protestar após 30 dias.",
        "Após o vencimento 1% a.m."
      ],
      key: {
        type: "CNPJ",
        dictKey: SANTANDER_DICT_KEY
      },
      discount: {
        type: "VALOR_DATA_FIXA",
        discountOne: {
          value: "0.10",
          limitDate: dueDate
        }
      },
      interestPercentage: "1.00"
    };

    console.log("[Santander] Payload enviado:", JSON.stringify(payload, null, 2));

    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/workspaces/${workspaceId}/bank_slips`,
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CLIENT_ID,
          'Authorization': 'Bearer ' + token
        }
      }
    );

    console.log('[Santander] Boleto registrado com sucesso:', response.data);

    return {
      ...response.data,
      nsuCode: nsuCode,
      bankNumber: bankNumber,
      dueDate: dueDate
    };
  } catch (error) {
    console.error('[Santander] Erro ao registrar boleto:', error.response?.data || error.message);
    throw error;
  }
}

// Função para gerar PDF do boleto
async function gerarPdfBoleto(digitableLine, pagadorDocumento) {
  try {
    const token = await obterTokenSantander();

    const response = await axios.post(
      `https://trust-open.api.santander.com.br/collection_bill_management/v2/bills/${digitableLine}/bank_slips`,
      { payerDocumentNumber: pagadorDocumento || "12345678900" },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Application-Key': SANTANDER_CLIENT_ID,
          'Authorization': 'Bearer ' + token
        }
      }
    );

    console.log('[Santander] PDF gerado:', response.data);

    if (response.data.link) return response.data.link;
    throw new Error('Link de download não encontrado na resposta');
  } catch (error) {
    console.error('[Santander] Erro ao gerar PDF:', error.response?.data || error.message);
    throw error;
  }
}

// Rota para gerar boleto
app.post('/api/gerar-boleto', async (req, res) => {
  try {
    const { profissionalId, vendedorId, dataReferencia, valorCompra, observacao, pontos, lojistaId } = req.body;

    if (!profissionalId || !vendedorId || !dataReferencia || !valorCompra || !pontos || !lojistaId) {
      return res.status(400).json({ error: 'Dados obrigatórios não fornecidos' });
    }

    const lojistaDoc = await db.collection('lojistas').doc(lojistaId).get();
    if (!lojistaDoc.exists) {
      return res.status(404).json({ error: 'Lojista não encontrado' });
    }
    const lojistaData = lojistaDoc.data();

    const valorBoleto = (pontos * 0.02).toFixed(2);

    const dadosBoleto = {
      profissionalId,
      valor: parseFloat(valorBoleto),
      pagadorNome: lojistaData.nomeFantasia || "Loja Mendes Connexions",
      pagadorDocumento: lojistaData.cnpj || "12345678901234",
      pagadorEndereco: lojistaData.endereco || "Endereço não informado",
      pagadorBairro: lojistaData.bairro || "Bairro não informado",
      pagadorCidade: lojistaData.cidade || "Cidade não informada",
      pagadorEstado: lojistaData.estado || "SP",
      pagadorCEP: lojistaData.cep || "00000-000",
      clientNumber: lojistaData.idNumber || "00001"
    };

    const boletoResponse = await registrarBoletoSantander(dadosBoleto);

    res.json({
      success: true,
      boleto: boletoResponse,
      valorBoleto: parseFloat(valorBoleto),
      vencimento: new Date(boletoResponse.dueDate)
    });
  } catch (error) {
    console.error('[API] Erro ao gerar boleto:', error);
    res.status(500).json({ error: 'Erro interno ao gerar boleto' });
  }
});

// Rota para baixar PDF do boleto
app.post('/api/baixar-pdf', async (req, res) => {
  try {
    const { digitableLine, pagadorDocumento } = req.body;

    if (!digitableLine) return res.status(400).json({ error: 'Linha digitável não fornecida' });

    const pdfUrl = await gerarPdfBoleto(digitableLine, pagadorDocumento);

    res.json({ success: true, pdfUrl });
  } catch (error) {
    console.error('[API] Erro ao gerar PDF:', error);
    res.status(500).json({ error: 'Erro interno ao gerar PDF' });
  }
});

// Rota para verificar status da integração
app.get('/api/status-integracao', async (req, res) => {
  try {
    await obterTokenSantander();
    res.json({ status: 'conectado', message: 'Conectado ao Santander com sucesso' });
  } catch (error) {
    res.json({ status: 'erro', message: 'Erro ao conectar com Santander' });
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
