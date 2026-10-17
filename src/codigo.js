// Código de conferência: impressão digital (SHA-256) dos dados da compra.
// Qualquer mudança em data, pessoa, comércio, itens, valores ou hora de criação muda o código.
export async function codigoConferencia(c) {
  const base = JSON.stringify([
    c.data || "", c.quem || "", c.loja || "",
    (c.itens || []).map(i => [String(i.produto || ""), Number(i.quantidade) || 0, Math.round((Number(i.valor) || 0) * 100)]),
    Math.round((Number(c.total) || 0) * 100), c.criadoEm || "",
  ]);
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(base)));
  const hex = [...h.slice(0, 4)].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();
  return hex.slice(0, 4) + "-" + hex.slice(4, 8);
}
