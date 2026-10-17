import { onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, sendPasswordResetEmail, signOut } from "firebase/auth";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, orderBy, onSnapshot, writeBatch, serverTimestamp } from "firebase/firestore";
import { ref as sref, uploadBytes, getDownloadURL } from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";
import { auth, db, storage, functions } from "./firebase.js";
import { SITE } from "./config.js";
import { codigoConferencia } from "./codigo.js";

const $ = s => document.querySelector(s);
const CATS = ["Mercearia", "Bebidas", "Carnes", "Hortifrúti", "Padaria", "Laticínios", "Limpeza", "Higiene", "Lanches e doces", "Gás e outros"];
const brl = n => (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const hoje = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const fmtData = s => { if (!s) return ""; const [y, m, d] = s.split("-"); return `${d}/${m}/${y}`; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
const nativo = Capacitor.isNativePlatform();
if (nativo) document.body.classList.add("nativo");

const lerFotoFn = httpsCallable(functions, "lerFoto", { timeout: 120000 });
const analisarFn = httpsCallable(functions, "analisarPeriodo", { timeout: 180000 });

let perfil = null;      // {familiaId, nome, papel}
let familia = null;     // {nome, loja, donoUid, codigo}
let compras = [];
let membros = [];
let carregou = false;
let rascunho = null;
let ultimaSalva = null;
let periodo = "mes";
let papelNovo = "filho";
let desligar = [];
const fotoUrls = new Map();

function aviso(msg, tipo = "warn") { const el = $("#globalNote"); if (!msg) { el.hidden = true; return; } el.className = "notice " + tipo; el.textContent = msg; el.hidden = false; }
const ehPai = () => perfil?.papel === "pai";

/* ---------------- entrar / criar conta ---------------- */
function mostrar(tela) {
  $("#carregando").hidden = true; $("#carregando").style.display = "none";
  $("#telaAuth").hidden = tela !== "auth";
  $("#telaApp").hidden = tela !== "app";
  $("#nav").hidden = tela !== "app";
}
function abaAuth(qual) {
  $("#abaEntrar").setAttribute("aria-pressed", String(qual === "entrar"));
  $("#abaCriar").setAttribute("aria-pressed", String(qual === "criar"));
  $("#formEntrar").hidden = qual !== "entrar"; $("#formCriar").hidden = qual !== "criar";
}
$("#abaEntrar").onclick = () => abaAuth("entrar");
$("#abaCriar").onclick = () => abaAuth("criar");
function setPapel(p) {
  papelNovo = p;
  $("#papelFilho").setAttribute("aria-pressed", String(p === "filho"));
  $("#papelPai").setAttribute("aria-pressed", String(p === "pai"));
  $("#boxCodigo").hidden = p !== "filho"; $("#boxLoja").hidden = p !== "pai";
}
$("#papelFilho").onclick = () => setPapel("filho");
$("#papelPai").onclick = () => setPapel("pai");

function msgErroAuth(e) {
  const c = e?.code || "";
  if (c.includes("invalid-credential") || c.includes("wrong-password") || c.includes("user-not-found")) return "E-mail ou senha errados.";
  if (c.includes("email-already-in-use")) return "Já existe uma conta com esse e-mail. Toque em Entrar.";
  if (c.includes("weak-password")) return "A senha precisa ter pelo menos 6 caracteres.";
  if (c.includes("invalid-email")) return "Esse e-mail não parece certo.";
  if (c.includes("network")) return "Sem internet. Tente de novo quando conectar.";
  if (c.includes("too-many-requests")) return "Muitas tentativas. Espere alguns minutos.";
  return e?.message || "Não deu certo. Tente de novo.";
}
function erro(el, msg) { el.textContent = msg; el.hidden = !msg; }

$("#formEntrar").addEventListener("submit", async ev => {
  ev.preventDefault(); erro($("#entErro"), "");
  try { await signInWithEmailAndPassword(auth, $("#entEmail").value.trim(), $("#entSenha").value); }
  catch (e) { erro($("#entErro"), msgErroAuth(e)); }
});
$("#btnEsqueci").onclick = async () => {
  const email = $("#entEmail").value.trim();
  if (!email) { erro($("#entErro"), "Escreva seu e-mail acima e toque de novo em Esqueci a senha."); return; }
  try { await sendPasswordResetEmail(auth, email); erro($("#entErro"), "Mandamos um e-mail para você criar uma senha nova."); }
  catch (e) { erro($("#entErro"), msgErroAuth(e)); }
};

function gerarCodigo() {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const a = crypto.getRandomValues(new Uint8Array(6));
  return [...a].map(x => letras[x % letras.length]).join("");
}
function gerarToken() {
  const a = crypto.getRandomValues(new Uint8Array(18));
  return [...a].map(x => x.toString(16).padStart(2, "0")).join("");
}

$("#formCriar").addEventListener("submit", async ev => {
  ev.preventDefault(); erro($("#criErro"), "");
  const nome = $("#criNome").value.trim(), email = $("#criEmail").value.trim(), senha = $("#criSenha").value;
  const codigo = $("#criCodigo").value.trim().toUpperCase();
  if (!nome) return erro($("#criErro"), "Escreva seu nome.");
  let convite = null;
  if (papelNovo === "filho" && codigo.length < 6) return erro($("#criErro"), "Digite o código de 6 letras que o responsável tem no app.");
  criando = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, senha);
    await updateProfile(cred.user, { displayName: nome });
    const uid = cred.user.uid;
    if (papelNovo === "pai") {
      const fid = doc(collection(db, "familias")).id;
      const cod = gerarCodigo();
      await setDoc(doc(db, "familias", fid), { nome: `Família de ${nome}`, loja: $("#criLoja").value.trim(), donoUid: uid, codigo: cod, chaveLojista: gerarToken(), criadoEm: new Date().toISOString() });
      await setDoc(doc(db, "convites", cod), { familiaId: fid });
      await setDoc(doc(db, "users", uid), { familiaId: fid, nome, papel: "pai", criadoEm: new Date().toISOString() });
    } else {
      convite = await getDoc(doc(db, "convites", codigo));
      if (!convite.exists()) { await cred.user.delete().catch(() => {}); criando = false; return erro($("#criErro"), "Esse código não existe. Confira com o responsável."); }
      await setDoc(doc(db, "users", uid), { familiaId: convite.data().familiaId, nome, papel: "filho", codigo, criadoEm: new Date().toISOString() });
    }
    criando = false;
    await carregarPerfil(cred.user);
  } catch (e) { criando = false; erro($("#criErro"), msgErroAuth(e)); }
});

/* ---------------- sessão ---------------- */
let criando = false;
onAuthStateChanged(auth, async user => {
  desligar.forEach(f => f()); desligar = []; compras = []; membros = []; carregou = false; perfil = null; familia = null;
  if (!user) { mostrar("auth"); return; }
  if (criando) return; // o cadastro termina e chama carregarPerfil
  await carregarPerfil(user);
});

async function carregarPerfil(user) {
  try {
    const p = await getDoc(doc(db, "users", user.uid));
    if (!p.exists()) { mostrar("auth"); abaAuth("criar"); erro($("#criErro"), "Sua conta existe mas não está em nenhuma família. Fale com o responsável."); return; }
    perfil = p.data();
    $("#minhaConta").textContent = `${perfil.nome} · ${user.email} · ${ehPai() ? "Responsável" : "Família"}`;
    mostrar("app");
    abrirAba(ls.get("cad_tab") || "nova");
    ouvir();
  } catch (e) { mostrar("auth"); erro($("#entErro"), "Não consegui abrir sua conta. Verifique a internet."); }
}

function ouvir() {
  const fid = perfil.familiaId;
  desligar.push(onSnapshot(doc(db, "familias", fid), s => { familia = s.data() || {}; render(); }, () => {}));
  desligar.push(onSnapshot(query(collection(db, "users"), where("familiaId", "==", fid)), s => {
    membros = s.docs.map(d => ({ uid: d.id, ...d.data() })); render();
  }, () => {}));
  desligar.push(onSnapshot(query(collection(db, "familias", fid, "compras"), orderBy("data", "desc")), s => {
    compras = s.docs.map(d => ({ id: d.id, ...d.data() })).map(c => ({ ...c, itens: Array.isArray(c.itens) ? c.itens : [], total: Number(c.total) || 0, data: c.data || "", quem: c.quem || "?", status: c.status || "pendente" }))
      .sort((a, b) => b.data.localeCompare(a.data) || String(b.criadoEm || "").localeCompare(String(a.criadoEm || "")));
    carregou = true; render();
  }, () => { carregou = true; aviso("Não consegui abrir a caderneta. Feche e abra o app.", "bad"); render(); }));
}

$("#btnSair").onclick = () => signOut(auth);

/* ---------------- abas ---------------- */
document.querySelectorAll("#nav button").forEach(b => b.addEventListener("click", () => abrirAba(b.dataset.tab)));
function abrirAba(t) {
  if (!["nova", "conta", "analise", "familia"].includes(t)) t = "nova";
  document.querySelectorAll("#nav button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
  document.querySelectorAll(".tabp").forEach(s => { s.hidden = s.id !== "tab-" + t; });
  ls.set("cad_tab", t); window.scrollTo(0, 0);
}

/* ---------------- lançar compra ---------------- */
function linhaItem(it = {}) {
  const div = document.createElement("div"); div.className = "item";
  div.innerHTML = `<input class="p" placeholder="Produto" value="${esc(it.produto || "")}" aria-label="Produto">
    <input class="q num" type="number" min="0" step="any" inputmode="decimal" value="${esc(it.quantidade ?? 1)}" aria-label="Quantidade">
    <input class="v" type="text" inputmode="decimal" placeholder="0,00" value="${it.valor != null ? esc(Number(it.valor).toFixed(2).replace(".", ",")) : ""}" aria-label="Valor em reais">
    <button class="ghost" type="button" aria-label="Remover item" title="Remover">✕</button>
    <select class="cat" aria-label="Tipo de produto">${CATS.map(c => `<option ${c === it.categoria ? "selected" : ""}>${c}</option>`).join("")}</select>`;
  div.querySelector("button").onclick = () => { div.remove(); somar(); };
  div.querySelectorAll("input").forEach(i => i.addEventListener("input", somar));
  $("#itens").appendChild(div);
}
const parseValor = s => { s = String(s || "").trim().replace(/[^\d,.-]/g, ""); if (s.includes(",")) s = s.replace(/\./g, "").replace(",", "."); return Number(s) || 0; };
function lerItens() {
  return [...document.querySelectorAll("#itens .item")].map(d => ({
    produto: d.querySelector(".p").value.trim(), quantidade: Number(d.querySelector(".q").value) || 1,
    valor: Math.round(parseValor(d.querySelector(".v").value) * 100) / 100, categoria: d.querySelector(".cat").value,
  })).filter(i => i.produto || i.valor);
}
function somar() { $("#totalForm").textContent = brl(lerItens().reduce((a, i) => a + i.valor, 0)); }

function abrirRevisao() {
  $("#stepFoto").hidden = true; $("#stepBalcao").hidden = true; $("#stepRevisar").hidden = false;
  $("#data").value = hoje(); $("#loja").value = familia?.loja || ""; $("#obs").value = ""; $("#itens").innerHTML = "";
}
function resetNova() { rascunho = null; $("#stepRevisar").hidden = true; $("#stepBalcao").hidden = true; $("#stepFoto").hidden = false; $("#prev").hidden = true; $("#aiStatus").hidden = true; $("#foto").value = ""; }
$("#btnCancelar").onclick = resetNova;
$("#btnAddItem").onclick = () => { linhaItem(); somar(); };
$("#btnManual").onclick = () => { rascunho = { fotoBlob: null }; abrirRevisao(); linhaItem(); somar(); };

async function reduzir(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const max = 1600, k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
    return await new Promise(r => c.toBlob(b => r(b || file), "image/jpeg", 0.82));
  } catch (e) { return file; } finally { URL.revokeObjectURL(url); }
}
const paraBase64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });

$("#foto").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  const blob = await reduzir(f);
  rascunho = { fotoBlob: blob };
  abrirRevisao();
  const p = $("#prev"); p.src = URL.createObjectURL(blob); p.hidden = false;
  const st = $("#aiStatus");
  st.className = "notice"; st.innerHTML = '<span class="row"><span class="spin"></span> Lendo a foto…</span>'; st.hidden = false;
  try {
    const { data: r } = await lerFotoFn({ imagemBase64: await paraBase64(blob), mediaType: blob.type || "image/jpeg", hoje: hoje() });
    const itens = Array.isArray(r?.itens) ? r.itens : [];
    if (!itens.length) { linhaItem(); st.className = "notice warn"; st.textContent = "Não consegui ler produto e valor nessa foto. Preencha à mão ou tire outra foto mais de perto."; }
    else {
      itens.forEach(it => linhaItem({ produto: it.produto, quantidade: it.quantidade || 1, valor: Number(it.valor) || 0, categoria: CATS.includes(it.categoria) ? it.categoria : "Mercearia" }));
      if (r.loja && !$("#loja").value) $("#loja").value = r.loja;
      if (r.data && /^\d{4}-\d{2}-\d{2}$/.test(r.data)) $("#data").value = r.data;
      st.className = "notice ok"; st.textContent = `Li ${itens.length} ${itens.length > 1 ? "itens" : "item"}. Confira os valores antes de lançar.` + (r.observacao ? " " + r.observacao : "");
    }
  } catch (err) {
    linhaItem();
    st.className = "notice warn";
    const amigavel = ["functions/invalid-argument", "functions/failed-precondition", "functions/permission-denied", "functions/unauthenticated", "functions/resource-exhausted"].includes(err?.code);
    st.textContent = (amigavel ? String(err.message).replace(/\s*\[\d+\]/g, "") + " " : "Não consegui ler a foto agora. ") + "Preencha à mão.";
  }
  somar();
});

$("#btnSalvar").onclick = async () => {
  const itens = lerItens();
  if (!itens.length || itens.some(i => !i.produto)) { aviso("Cada item precisa de um nome de produto."); return; }
  if (itens.some(i => !i.valor)) { aviso("Cada item precisa de um valor. Para corrigir uma compra já confirmada, use valor negativo, por exemplo -11,99."); return; }
  aviso(null);
  const btn = $("#btnSalvar"); btn.disabled = true; btn.textContent = "Lançando…";
  try {
    const fid = perfil.familiaId;
    const cref = doc(collection(db, "familias", fid, "compras"));
    let fotoPath = null;
    if (rascunho?.fotoBlob) {
      try { fotoPath = `familias/${fid}/${cref.id}.jpg`; await uploadBytes(sref(storage, fotoPath), rascunho.fotoBlob, { contentType: "image/jpeg" }); }
      catch (e) { fotoPath = null; }
    }
    const token = gerarToken();
    const compra = {
      data: $("#data").value || hoje(), quem: perfil.nome, loja: $("#loja").value.trim(), itens,
      total: Math.round(itens.reduce((a, i) => a + i.valor, 0) * 100) / 100, obs: $("#obs").value.trim(),
      fotoPath, status: "pendente", pago: false, criadoEm: new Date().toISOString(), autorUid: auth.currentUser.uid, token,
    };
    compra.codigo = await codigoConferencia(compra);
    const b = writeBatch(db);
    b.set(cref, compra);
    b.set(doc(db, "confirmacoes", token), {
      familiaId: fid, compraId: cref.id, status: "pendente", quem: compra.quem, data: compra.data,
      loja: compra.loja, itens: itens.map(i => ({ produto: i.produto, quantidade: i.quantidade, valor: i.valor })), total: compra.total,
      familiaNome: familia?.nome || "", criadoEm: compra.criadoEm, codigo: compra.codigo,
    });
    await b.commit();
    ultimaSalva = { id: cref.id, ...compra };
    mostrarBalcao(ultimaSalva);
  } catch (e) {
    aviso("Não consegui lançar agora. Verifique a internet e tente de novo.", "bad");
  } finally { btn.disabled = false; btn.textContent = "Lançar na conta"; }
};

function tabelaItens(itens) {
  return `<table style="width:100%;border-collapse:collapse">${itens.map(i => `<tr><td style="padding:4px 0;border-bottom:1px dotted var(--line)">${esc(i.quantidade !== 1 ? i.quantidade + " × " : "")}${esc(i.produto)}</td><td class="num" style="text-align:right">${brl(i.valor)}</td></tr>`).join("")}</table>`;
}
function mostrarBalcao(c) {
  $("#stepRevisar").hidden = true; $("#stepFoto").hidden = true; $("#stepBalcao").hidden = false;
  $("#balcaoQuem").textContent = `${c.quem} · ${fmtData(c.data)}`;
  $("#balcaoItens").innerHTML = tabelaItens(c.itens);
  $("#balcaoTotal").textContent = brl(c.total);
  $("#balcaoCodigo").textContent = c.codigo || "";
  $("#balcaoNome").value = ls.get("cad_lojista") || "";
  window.scrollTo(0, 0);
}
async function responderBalcao(status) {
  const nome = $("#balcaoNome").value.trim();
  if (!nome) { $("#balcaoNome").focus(); aviso("Peça ao lojista para escrever o nome antes de responder."); return; }
  ls.set("cad_lojista", nome); aviso(null);
  try {
    const dados = { status, confirmadoPor: nome, confirmadoEm: serverTimestamp() };
    if (status === "contestada") dados.nota = "Lojista apontou erro no balcão";
    await updateDoc(doc(db, "confirmacoes", ultimaSalva.token), dados);
    aviso(status === "confirmada" ? "Compra confirmada pelo lojista." : "Marcada com erro. Apague e lance de novo com o valor certo.", status === "confirmada" ? "ok" : "warn");
  } catch (e) { aviso("Não consegui registrar a resposta. A compra fica esperando confirmação.", "bad"); }
  resetNova();
}
$("#btnBalcaoOk").onclick = () => responderBalcao("confirmada");
$("#btnBalcaoNao").onclick = () => responderBalcao("contestada");
$("#btnBalcaoDepois").onclick = () => { aviso("Lançada. Fica esperando o lojista confirmar.", "ok"); resetNova(); };
$("#btnBalcaoLink").onclick = () => enviarLink(ultimaSalva);

async function compartilharTexto(texto, titulo) {
  if (nativo) { try { await Share.share({ title: titulo, text: texto, dialogTitle: titulo }); return; } catch (e) { if (String(e?.message || "").toLowerCase().includes("cancel")) return; } }
  if (navigator.share) { try { await navigator.share({ title: titulo, text: texto }); return; } catch (e) { return; } }
  window.open("https://wa.me/?text=" + encodeURIComponent(texto), "_blank");
}
function enviarLink(c) {
  const link = `${SITE}/confirmar.html#${c.token}`;
  compartilharTexto(`Olá! Lancei na conta: ${c.itens.map(i => i.produto).join(", ")}, total ${brl(c.total)} (código ${c.codigo}). Pode confirmar aqui, por favor? ${link}`, "Confirmar compra");
}

/* ---------------- listas ---------------- */
function statusChip(c) { if (c.pago) return '<span class="chip paga">Paga</span>'; return `<span class="chip ${c.status}">${{ pendente: "Pendente", confirmada: "Confirmada", contestada: "Com erro" }[c.status] || "Pendente"}</span>`; }
function entryHTML(c, modo) {
  const nome = c.itens.length === 1 ? c.itens[0].produto : `${c.itens[0]?.produto || "Compra"} e mais ${c.itens.length - 1}`;
  const thumb = c.fotoPath ? `<img class="thumb" data-foto="${esc(c.fotoPath)}" alt="">` : `<div class="thumb">${esc((c.quem || "?")[0])}</div>`;
  const meu = c.autorUid === auth.currentUser?.uid;
  let acoes = "";
  if (modo === "conta" && !c.pago) {
    const podeApagar = c.status !== "confirmada" && (ehPai() || meu);
    acoes = `<div class="row" style="margin-top:8px">
      ${c.status === "pendente" && c.token ? `<button class="ghost" data-acao="link" data-id="${c.id}">Pedir confirmação ao lojista</button>` : ""}
      ${podeApagar ? `<button class="ghost" data-acao="apagar" data-id="${c.id}">Apagar</button><span data-conf="${c.id}" hidden class="row"><span class="small">Apagar mesmo?</span><button class="bad" data-acao="apagar2" data-id="${c.id}">Sim, apagar</button></span>` : ""}
    </div>`;
  }
  return `<div class="entry">${thumb}
    <div style="min-width:0"><div class="title">${esc(nome)}</div>
      <div class="meta">${esc(c.quem)} · ${fmtData(c.data)}${c.loja ? " · " + esc(c.loja) : ""}${c.codigo ? ` · <span class="num">${esc(c.codigo)}</span>` : ""}</div>
      ${c.confirmadoPor && c.status !== "pendente" ? `<div class="meta">${c.status === "confirmada" ? "Confirmada por" : "Erro apontado por"} ${esc(c.confirmadoPor)}${c.nota ? ": " + esc(c.nota) : ""}</div>` : ""}
    </div>
    <div class="val">${brl(c.total)}${statusChip(c)}</div>
    <details><summary>Ver itens${c.fotoPath ? " e foto" : ""}</summary>
      <table>${c.itens.map(i => `<tr><td>${esc(i.quantidade !== 1 ? i.quantidade + " × " : "")}${esc(i.produto)} <span class="muted small">${esc(i.categoria)}</span></td><td>${brl(i.valor)}</td></tr>`).join("")}</table>
      ${c.obs ? `<p class="small muted" style="margin-top:6px">${esc(c.obs)}</p>` : ""}
      ${c.fotoPath ? `<img data-foto="${esc(c.fotoPath)}" alt="Foto da compra" style="margin-top:8px;border-radius:8px;max-height:320px">` : ""}
      ${acoes}
    </details></div>`;
}
function carregarFotos(raiz) {
  raiz.querySelectorAll("img[data-foto]").forEach(async img => {
    const p = img.dataset.foto;
    try { if (!fotoUrls.has(p)) fotoUrls.set(p, getDownloadURL(sref(storage, p))); img.src = await fotoUrls.get(p); } catch (e) { fotoUrls.delete(p); }
  });
}
const vazio = msg => `<p class="muted small" style="padding:8px 0">${msg}</p>`;

function render() {
  if (!perfil) return;
  const abertas = compras.filter(c => !c.pago);
  const saldo = abertas.reduce((a, c) => a + c.total, 0);
  $("#saldoTop").textContent = brl(saldo); $("#saldoBig").textContent = brl(saldo);
  const sum = st => abertas.filter(c => c.status === st).reduce((a, c) => a + c.total, 0);
  $("#saldoSplit").innerHTML = `<span class="chip confirmada">Confirmado ${brl(sum("confirmada"))}</span><span class="chip pendente">Pendente ${brl(sum("pendente"))}</span>${sum("contestada") ? `<span class="chip contestada">Com erro ${brl(sum("contestada"))}</span>` : ""}`;
  $("#lojaNome").textContent = familia?.loja ? `Conta no ${familia.loja}` : "A conta da família no comércio";

  const carregando = carregou ? null : "Carregando a caderneta…";
  $("#listaRecentes").innerHTML = carregando ? vazio(carregando) : (compras.length ? compras.slice(0, 4).map(c => entryHTML(c)).join("") : vazio("Nenhuma compra lançada ainda. Tire a foto do primeiro produto que pegar na conta."));
  const sel = $("#filtroQuem"), fq = sel.value;
  const nomes = [...new Set([...membros.map(m => m.nome), ...compras.map(c => c.quem)])];
  sel.innerHTML = '<option value="">Todos</option>' + nomes.map(n => `<option>${esc(n)}</option>`).join(""); sel.value = nomes.includes(fq) ? fq : "";
  const lista = compras.filter(c => !sel.value || c.quem === sel.value);
  $("#listaConta").innerHTML = carregando ? vazio(carregando) : (lista.length ? lista.map(c => entryHTML(c, "conta")).join("") : vazio("Nada lançado ainda."));
  carregarFotos($("#telaApp"));

  const pb = $("#pagarBox");
  pb.hidden = !(ehPai() && abertas.length);
  if (!pb.hidden && !pb.dataset.confirmando) pb.innerHTML = '<button id="btnPagar" type="button">Registrar pagamento da conta</button>';

  // família
  $("#boxConvite").hidden = !ehPai(); $("#boxAjustes").hidden = !ehPai(); $("#boxExtrato").hidden = !(ehPai() && familia?.chaveLojista);
  $("#codigoConvite").textContent = familia?.codigo || "------";
  if (ehPai() && document.activeElement !== $("#cfgLoja")) $("#cfgLoja").value = familia?.loja || "";
  $("#listaMembros").innerHTML = membros.length ? membros.map(m => `<div class="membro"><span><b>${esc(m.nome)}</b> <span class="small muted">${m.papel === "pai" ? "Responsável" : ""}</span></span>
    ${ehPai() && m.papel !== "pai" ? `<button class="ghost" data-acao="tirar" data-id="${m.uid}">Tirar da família</button>` : ""}</div>`).join("") : vazio("Carregando…");
  renderAnalise();
}

document.addEventListener("click", async e => {
  const b = e.target.closest("button[data-acao]"); if (!b) return;
  const id = b.dataset.id, a = b.dataset.acao, fid = perfil?.familiaId;
  try {
    if (a === "link") enviarLink(compras.find(c => c.id === id));
    if (a === "apagar") document.querySelector(`[data-conf="${id}"]`).hidden = false;
    if (a === "apagar2") {
      b.disabled = true; const c = compras.find(x => x.id === id);
      await deleteDoc(doc(db, "familias", fid, "compras", id));
      if (c?.token && c.status === "pendente") deleteDoc(doc(db, "confirmacoes", c.token)).catch(() => {});
    }
    if (a === "tirar") { b.disabled = true; await deleteDoc(doc(db, "users", id)); aviso("Pessoa retirada da família. Para voltar, ela precisa criar outra conta com o código.", "ok"); }
  } catch (err) { b.disabled = false; aviso("Não foi possível fazer isso. Só quem lançou ou o responsável pode mudar.", "bad"); }
});
$("#filtroQuem").addEventListener("change", render);

/* pagamento (só o responsável) */
$("#pagarBox").addEventListener("click", async e => {
  const box = $("#pagarBox");
  const abertas = compras.filter(c => !c.pago && c.status === "confirmada"), total = abertas.reduce((a, c) => a + c.total, 0);
  if (e.target.id === "btnPagar") {
    if (!abertas.length) { aviso("Ainda não há compras confirmadas pelo lojista para pagar."); return; }
    box.dataset.confirmando = "1";
    const pend = compras.filter(c => !c.pago && c.status !== "confirmada").length;
    box.innerHTML = `<span>Marcar as compras confirmadas (${brl(total)}) como pagas hoje?${pend ? ` As ${pend} que não foram confirmadas continuam em aberto.` : ""}</span><button class="ok fill" id="pagarSim" type="button">Sim, foi pago</button><button class="ghost" id="pagarNao" type="button">Não</button>`;
  } else if (e.target.id === "pagarNao") { delete box.dataset.confirmando; render(); }
  else if (e.target.id === "pagarSim") {
    e.target.disabled = true;
    try {
      for (let i = 0; i < abertas.length; i += 400) {
        const b = writeBatch(db);
        abertas.slice(i, i + 400).forEach(c => b.update(doc(db, "familias", perfil.familiaId, "compras", c.id), { pago: true, pagoEm: hoje() }));
        await b.commit();
      }
      aviso(`Pagamento de ${brl(total)} registrado.`, "ok");
    } catch (err) { aviso("O pagamento não foi registrado. Tente de novo.", "bad"); }
    delete box.dataset.confirmando; render();
  }
});

$("#btnSalvarLoja").onclick = async () => {
  try { await updateDoc(doc(db, "familias", perfil.familiaId), { loja: $("#cfgLoja").value.trim() }); aviso("Salvo.", "ok"); }
  catch (e) { aviso("Não consegui salvar.", "bad"); }
};
$("#btnExtrato").onclick = () => compartilharTexto(`Olá! Este é o extrato da conta da ${familia?.nome || "nossa família"}. Aqui ficam todas as compras que você confirmou, e só o sistema escreve nele: ${SITE}/extrato.html#${familia?.chaveLojista}`, "Extrato do lojista");
$("#btnCompartilharCodigo").onclick = () => compartilharTexto(`Instale o app Caderneta, toque em "Criar conta" e use o código da nossa família: ${familia?.codigo}`, "Código da família");

/* planilha */
$("#btnCsv").onclick = async () => {
  const linhas = [["Data", "Quem", "Comércio", "Produto", "Tipo", "Quantidade", "Valor (R$)", "Situação", "Confirmado por", "Pago em"]];
  compras.slice().sort((a, b) => a.data.localeCompare(b.data)).forEach(c => c.itens.forEach(i => linhas.push([fmtData(c.data), c.quem, c.loja, i.produto, i.categoria, String(i.quantidade).replace(".", ","), Number(i.valor).toFixed(2).replace(".", ","), c.pago ? "Paga" : c.status, c.confirmadoPor || "", c.pagoEm ? fmtData(c.pagoEm) : ""])));
  const csv = "﻿" + linhas.map(l => l.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
  const nome = `caderneta-${hoje()}.csv`;
  try {
    if (nativo) {
      const w = await Filesystem.writeFile({ path: nome, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
      await Share.share({ title: "Planilha da caderneta", files: [w.uri], dialogTitle: "Salvar ou enviar planilha" });
    } else {
      const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = nome; a.click();
    }
  } catch (e) { if (!String(e?.message || "").toLowerCase().includes("cancel")) aviso("Não consegui gerar a planilha agora."); }
};

/* ---------------- análise ---------------- */
const PERIODOS = [["mes", "Este mês"], ["passado", "Mês passado"], ["30", "Últimos 30 dias"], ["aberto", "Conta em aberto"], ["tudo", "Tudo"]];
$("#periodos").innerHTML = PERIODOS.map(([k, l]) => `<button type="button" data-p="${k}" aria-pressed="${k === periodo}">${l}</button>`).join("");
$("#periodos").addEventListener("click", e => { const b = e.target.closest("[data-p]"); if (!b) return; periodo = b.dataset.p; document.querySelectorAll("#periodos button").forEach(x => x.setAttribute("aria-pressed", String(x === b))); $("#aiTexto").textContent = ""; renderAnalise(); });

function limites() {
  const d = new Date(), h = hoje();
  const pm = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  const ymp = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, "0")}`;
  const lim = new Date(d.getTime() - 30 * 864e5); lim.setMinutes(lim.getMinutes() - lim.getTimezoneOffset());
  if (periodo === "mes") return { inicio: h.slice(0, 7) + "-01", fim: h.slice(0, 7) + "-31" };
  if (periodo === "passado") return { inicio: ymp + "-01", fim: ymp + "-31" };
  if (periodo === "30") return { inicio: lim.toISOString().slice(0, 10), fim: h };
  return {};
}
function noPeriodo(lista) {
  if (periodo === "aberto") return lista.filter(c => !c.pago);
  const { inicio, fim } = limites();
  return lista.filter(c => (!inicio || c.data >= inicio) && (!fim || c.data <= fim));
}
function barras(el, mapa, max = 8) {
  const arr = [...mapa.entries()].sort((a, b) => b[1] - a[1]).slice(0, max); const top = arr[0]?.[1] || 1;
  el.innerHTML = arr.length ? arr.map(([n, v]) => `<div class="bar"><span class="n" title="${esc(n)}">${esc(n)}</span><span class="t"><i style="width:${Math.max(2, v / top * 100)}%"></i></span><span class="v">${brl(v)}</span></div>`).join("") : vazio("Sem compras neste período.");
}
function renderAnalise() {
  const sel = noPeriodo(compras);
  const total = sel.reduce((a, c) => a + c.total, 0);
  const maior = sel.reduce((m, c) => c.total > (m?.total || 0) ? c : m, null);
  $("#kpis").innerHTML = [["Gasto no período", brl(total)], ["Compras", String(sel.length)], ["Média por compra", brl(sel.length ? total / sel.length : 0)], ["Maior compra", maior ? brl(maior.total) : "—"]]
    .map(([l, v]) => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}</div></div>`).join("");
  const prod = new Map(), cat = new Map(), pes = new Map();
  sel.forEach(c => { pes.set(c.quem, (pes.get(c.quem) || 0) + c.total); c.itens.forEach(i => { const k = i.produto.trim(); prod.set(k, (prod.get(k) || 0) + i.valor); cat.set(i.categoria, (cat.get(i.categoria) || 0) + i.valor); }); });
  barras($("#barProd"), prod, 10); barras($("#barCat"), cat); barras($("#barPessoa"), pes);
  const d = new Date(), meses = [];
  for (let k = 5; k >= 0; k--) { const x = new Date(d.getFullYear(), d.getMonth() - k, 1); meses.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`); }
  const vals = meses.map(m => compras.filter(c => c.data.startsWith(m)).reduce((a, c) => a + c.total, 0)); const mx = Math.max(...vals, 1);
  $("#mesesBar").innerHTML = meses.map((m, i) => `<div class="m ${i === 5 ? "cur" : ""}"><span>${vals[i] ? Math.round(vals[i]) : ""}</span><i style="height:${vals[i] ? Math.max(2, vals[i] / mx * 100) : 0}%"></i></div>`).join("");
  $("#mesesLbl").innerHTML = meses.map(m => `<span>${new Date(m + "-15T12:00").toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")}</span>`).join("");
}
$("#btnAnalise").onclick = async () => {
  const out = $("#aiTexto");
  if (!noPeriodo(compras).length) { out.textContent = "Não há compras neste período para analisar."; return; }
  const btn = $("#btnAnalise"); btn.disabled = true; out.innerHTML = '<span class="row"><span class="spin"></span> Analisando…</span>';
  try {
    const { data } = await analisarFn({ nomePeriodo: PERIODOS.find(p => p[0] === periodo)[1], hoje: hoje(), ...limites(), soEmAberto: periodo === "aberto" });
    out.textContent = data?.texto || "Sem resposta.";
  } catch (e) { out.textContent = "Não consegui analisar agora. Verifique a internet e tente de novo."; }
  finally { btn.disabled = false; }
};
