import { collection, query, orderBy, onSnapshot } from "firebase/firestore";
import { db } from "./firebase.js";

const $ = s => document.querySelector(s);
const brl = n => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtData = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
const fmtHora = t => t?.toDate ? t.toDate().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const chave = location.hash.slice(1);

function estado(msg, tipo = "") { const el = $("#estado"); el.className = "notice " + tipo; el.textContent = msg; el.hidden = !msg; }

if (chave.length < 20) estado("Este link está incompleto. Peça para enviarem de novo.", "bad");
else onSnapshot(query(collection(db, "extratos", chave, "compras"), orderBy("data", "desc")), s => {
  const itens = s.docs.map(d => d.data());
  if (!itens.length) { estado("Ainda não há compras confirmadas neste extrato."); $("#lista").innerHTML = ""; return; }
  estado("");
  $("#familia").textContent = itens[0].familiaNome ? `Conta da ${itens[0].familiaNome}` : "Compras confirmadas na conta";
  $("#aberto").textContent = brl(itens.filter(c => c.status === "confirmada" && !c.pago).reduce((a, c) => a + (Number(c.total) || 0), 0));
  $("#lista").innerHTML = itens.map(c => `<div class="entry"><div class="thumb">${esc((c.quem || "?")[0])}</div>
    <div style="min-width:0"><div class="title">${esc((c.itens || []).map(i => i.produto).join(", "))}</div>
      <div class="meta">${esc(c.quem)} · ${fmtData(c.data)} · código <span class="num">${esc(c.codigo)}</span></div>
      <div class="meta">${c.status === "confirmada" ? "Confirmada" : "Erro apontado"} por ${esc(c.confirmadoPor)} em ${fmtHora(c.confirmadoEm)}${c.nota ? ": " + esc(c.nota) : ""}</div></div>
    <div class="val">${brl(c.total)}${c.pago ? '<span class="chip paga">Paga</span>' : c.status === "confirmada" ? '<span class="chip confirmada">A receber</span>' : '<span class="chip contestada">Com erro</span>'}</div>
    <details><summary>Ver itens</summary><table>${(c.itens || []).map(i => `<tr><td>${esc(i.quantidade !== 1 ? i.quantidade + " × " : "")}${esc(i.produto)}</td><td>${brl(i.valor)}</td></tr>`).join("")}</table></details></div>`).join("");
}, () => estado("Não consegui abrir o extrato. Verifique o link e a internet.", "bad"));
