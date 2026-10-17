import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { codigoConferencia } from "./codigo.js";
import { db } from "./firebase.js";

const $ = s => document.querySelector(s);
const brl = n => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtData = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const token = location.hash.slice(1);
const ref = token.length >= 20 ? doc(db, "confirmacoes", token) : null;

function estado(msg, tipo = "") { const el = $("#estado"); el.className = "notice " + tipo; el.textContent = msg; el.hidden = !msg; }

async function abrir() {
  if (!ref) return estado("Este link está incompleto. Peça para enviarem de novo.", "bad");
  let s;
  try { s = await getDoc(ref); } catch (e) { return estado("Não consegui abrir. Verifique a internet e recarregue a página.", "bad"); }
  if (!s.exists()) return estado("Esta compra não existe mais. Ela pode ter sido apagada pela família.", "warn");
  const c = s.data();
  $("#quem").textContent = `${c.quem} · ${fmtData(c.data)}${c.loja ? " · " + c.loja : ""}`;
  $("#itens").innerHTML = `<table style="width:100%;border-collapse:collapse">${(c.itens || []).map(i => `<tr><td style="padding:4px 0;border-bottom:1px dotted var(--line)">${esc(i.quantidade !== 1 ? i.quantidade + " × " : "")}${esc(i.produto)}</td><td class="num" style="text-align:right">${brl(i.valor)}</td></tr>`).join("")}</table>`;
  $("#total").textContent = brl(c.total);
  const calc = await codigoConferencia(c);
  const ok = calc === c.codigo;
  $("#conf").className = "notice " + (ok ? "ok" : "bad");
  $("#conf").textContent = ok ? `Código de conferência ${c.codigo}: confere com os itens e valores acima.` : "Atenção: o código de conferência não bate com os dados. Não confirme e fale com a família.";
  $("#cartao").hidden = false;
  if (!ok) $("#ok").disabled = true;
  try { $("#nome").value = localStorage.getItem("cad_lojista") || ""; } catch (e) {}
  if (c.status !== "pendente") {
    $("#perguntar").hidden = true;
    estado(c.status === "confirmada" ? `Já confirmada por ${c.confirmadoPor}.` : `Erro já apontado por ${c.confirmadoPor}${c.nota ? ": " + c.nota : ""}.`, c.status === "confirmada" ? "ok" : "warn");
  } else estado("");
}

async function responder(status, nota) {
  const nome = $("#nome").value.trim();
  if (!nome) { $("#nome").focus(); return estado("Escreva seu nome antes de responder.", "warn"); }
  try { localStorage.setItem("cad_lojista", nome); } catch (e) {}
  document.querySelectorAll("#perguntar button").forEach(b => b.disabled = true);
  const dados = { status, confirmadoPor: nome, confirmadoEm: serverTimestamp() };
  if (nota) dados.nota = nota;
  try {
    await updateDoc(ref, dados);
    $("#perguntar").hidden = true;
    estado(status === "confirmada" ? "Pronto, compra confirmada. Obrigado!" : "Pronto, a família foi avisada do erro.", status === "confirmada" ? "ok" : "warn");
  } catch (e) {
    document.querySelectorAll("#perguntar button").forEach(b => b.disabled = false);
    estado("Não consegui registrar. Esta compra pode já ter sido respondida. Recarregue a página.", "bad");
  }
}
$("#ok").onclick = () => responder("confirmada");
$("#nao").onclick = () => { $("#boxNota").hidden = false; $("#nota").focus(); };
$("#enviarErro").onclick = () => responder("contestada", $("#nota").value.trim() || "Lojista apontou erro");
abrir();
