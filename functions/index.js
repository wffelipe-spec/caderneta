import { onCall, HttpsError } from "firebase-functions/v2/https";
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { defineSecret } from "firebase-functions/params";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import Anthropic from "@anthropic-ai/sdk";

initializeApp();
const db = getFirestore();
const ANTHROPIC_API_KEY = defineSecret("ANTHROPIC_API_KEY");
const MODELO = "claude-opus-5-5";
const REGIAO = "southamerica-east1";

const CATEGORIAS = ["Mercearia", "Bebidas", "Carnes", "Hortifrúti", "Padaria", "Laticínios",
  "Limpeza", "Higiene", "Lanches e doces", "Gás e outros"];

async function exigirMembro(auth) {
  if (!auth) throw new HttpsError("unauthenticated", "Entre na sua conta primeiro.");
  const perfil = await db.doc(`users/${auth.uid}`).get();
  if (!perfil.exists) throw new HttpsError("permission-denied", "Sua conta ainda não está em uma família.");
  return perfil.data();
}

function textoDaResposta(resp) {
  if (resp.stop_reason === "refusal") throw new HttpsError("failed-precondition", "A IA não conseguiu analisar isso.");
  return resp.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
}

async function chamarClaude(cliente, params) {
  try {
    // Fallback do lado do servidor: se o modelo recusar por engano, outro modelo continua.
    return await cliente.beta.messages.create({
      model: MODELO,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      ...params,
    });
  } catch (e) {
    console.error("Erro na API da Anthropic", e?.status, e?.message);
    if (e instanceof Anthropic.RateLimitError) throw new HttpsError("resource-exhausted", "Muitas leituras seguidas. Espere um minuto.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpsError("failed-precondition", "A chave da IA não está configurada certo.");
    throw new HttpsError("unavailable", "A IA não respondeu agora.");
  }
}

const SCHEMA_LEITURA = {
  type: "object",
  additionalProperties: false,
  required: ["loja", "data", "itens", "observacao"],
  properties: {
    loja: { type: "string", description: "Nome do comércio, ou vazio" },
    data: { type: "string", description: "AAAA-MM-DD, ou vazio" },
    itens: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["produto", "categoria", "quantidade", "valor"],
        properties: {
          produto: { type: "string" },
          categoria: { type: "string", enum: CATEGORIAS },
          quantidade: { type: "number" },
          valor: { type: "number", description: "Valor total do item em reais" },
        },
      },
    },
    observacao: { type: "string" },
  },
};

// Lê a foto do produto/nota e devolve os itens com valor.
export const lerFoto = onCall({ region: REGIAO, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 120, memory: "512MiB" }, async (req) => {
  await exigirMembro(req.auth);
  const { imagemBase64, mediaType, hoje } = req.data || {};
  if (typeof imagemBase64 !== "string" || imagemBase64.length < 100 || imagemBase64.length > 7_000_000) {
    throw new HttpsError("invalid-argument", "Foto inválida ou grande demais.");
  }
  const tipo = ["image/jpeg", "image/png", "image/webp"].includes(mediaType) ? mediaType : "image/jpeg";
  const cliente = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

  const prompt = `Você está ajudando uma família brasileira a controlar a conta (fiado) num pequeno comércio. A imagem é uma foto tirada no balcão: pode ser um produto com etiqueta de preço, uma prateleira com preço, um cupom ou nota, ou uma anotação à mão do lojista.
Liste cada produto comprado com o valor TOTAL do item em reais (preço unitário vezes quantidade quando der para saber). Use nomes curtos e padronizados em português, com marca e tamanho quando aparecerem (ex.: "Arroz Tio João 5kg", "Coca-Cola 2L", "Pão francês"), para que o mesmo produto tenha sempre o mesmo nome.
Se não houver data ou nome do comércio visível, deixe o campo vazio. Hoje é ${typeof hoje === "string" ? hoje.slice(0, 10) : "desconhecido"}.
Em "observacao", escreva em uma frase curta qualquer dúvida (preço borrado, quantidade incerta), ou deixe vazio.
Se não houver produto ou preço legível, devolva "itens" vazio.`;

  const resp = await chamarClaude(cliente, {
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA_LEITURA } },
    messages: [{
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: tipo, data: imagemBase64 } },
        { type: "text", text: prompt },
      ],
    }],
  });
  try {
    return JSON.parse(textoDaResposta(resp));
  } catch (e) {
    if (e instanceof HttpsError) throw e;
    throw new HttpsError("internal", "Não consegui entender a resposta da IA.");
  }
});

// Análise do período em português simples, para o pai.
export const analisarPeriodo = onCall({ region: REGIAO, secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 180 }, async (req) => {
  const perfil = await exigirMembro(req.auth);
  const { nomePeriodo, hoje, inicio, fim, soEmAberto } = req.data || {};
  let q = db.collection(`familias/${perfil.familiaId}/compras`);
  if (typeof inicio === "string") q = q.where("data", ">=", inicio);
  if (typeof fim === "string") q = q.where("data", "<=", fim);
  const snap = await q.get();
  const linhas = [];
  snap.forEach(d => {
    const c = d.data();
    if (soEmAberto && c.pago) return;
    (c.itens || []).forEach(i => linhas.push(`${c.data};${c.quem};${i.produto};${i.categoria};${i.quantidade};${Number(i.valor).toFixed(2)}`));
  });
  if (!linhas.length) return { texto: "Não há compras neste período para analisar." };

  const cliente = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  const resp = await chamarClaude(cliente, {
    max_tokens: 8000,
    output_config: { effort: "medium" },
    messages: [{
      role: "user",
      content: `Você é um consultor de finanças domésticas falando com um pai de família brasileiro, em português simples e direto. Abaixo estão as compras feitas na conta (fiado) do comércio no período "${String(nomePeriodo || "").slice(0, 40)}" (hoje é ${String(hoje || "").slice(0, 10)}), uma por linha: data;quem;produto;categoria;quantidade;valor em R$.
${linhas.slice(0, 3000).join("\n")}

Escreva no máximo 6 tópicos curtos, cada um começando com "• ", sem outra formatação:
quanto foi gasto no total e quem mais gastou; os produtos e categorias que mais pesaram; padrões que chamam atenção (compras repetidas, supérfluos, dias de muito gasto); e 2 ou 3 sugestões práticas de economia com valor estimado em reais.
Use apenas os dados acima e não invente números.`,
    }],
  });
  return { texto: textoDaResposta(resp) };
});

// Quando o lojista responde (no link ou na tela do celular), a compra da família muda de
// situação e uma cópia vai para o extrato do lojista, que só o servidor escreve.
export const sincronizarConfirmacao = onDocumentUpdated({ document: "confirmacoes/{token}", region: REGIAO }, async (event) => {
  const antes = event.data.before.data();
  const depois = event.data.after.data();
  if (!depois || antes.status === depois.status) return;
  const compraRef = db.doc(`familias/${depois.familiaId}/compras/${depois.compraId}`);
  const [compra, familia] = await Promise.all([compraRef.get(), db.doc(`familias/${depois.familiaId}`).get()]);
  if (!compra.exists) return;
  const c = compra.data();
  // Confere se a compra da família ainda é igual ao que o lojista viu.
  const iguais = c.codigo === depois.codigo && Math.round(c.total * 100) === Math.round(depois.total * 100);
  const status = iguais ? depois.status : "contestada";
  const nota = iguais ? (depois.nota || "") : "Os dados da compra mudaram depois do envio ao lojista";
  await compraRef.update({ status, confirmadoPor: depois.confirmadoPor || "", confirmadoEm: depois.confirmadoEm || FieldValue.serverTimestamp(), nota });
  const chave = familia.data()?.chaveLojista;
  if (chave) {
    await db.doc(`extratos/${chave}/compras/${depois.compraId}`).set({
      familiaNome: familia.data().nome || "", quem: depois.quem, data: depois.data, loja: depois.loja || "",
      itens: depois.itens || [], total: depois.total, codigo: depois.codigo, criadoEm: depois.criadoEm,
      status, nota, confirmadoPor: depois.confirmadoPor || "", confirmadoEm: depois.confirmadoEm || FieldValue.serverTimestamp(),
      pago: false,
    });
  }
});

// Quando o responsável registra o pagamento, o extrato do lojista mostra a compra como paga.
export const sincronizarPagamento = onDocumentUpdated({ document: "familias/{fid}/compras/{cid}", region: REGIAO }, async (event) => {
  const antes = event.data.before.data(), depois = event.data.after.data();
  if (!depois || antes.pago === depois.pago) return;
  const familia = await db.doc(`familias/${event.params.fid}`).get();
  const chave = familia.data()?.chaveLojista;
  if (!chave) return;
  const ref = db.doc(`extratos/${chave}/compras/${event.params.cid}`);
  if ((await ref.get()).exists) await ref.update({ pago: !!depois.pago, pagoEm: depois.pagoEm || null });
});
