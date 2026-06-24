import { generateText } from 'ai'
import { Nominee } from 'nominee'
import { createWorkersAI } from 'workers-ai-provider'

interface RateLimit {
  limit(opts: { key: string }): Promise<{ success: boolean }>
}
interface Env {
  AI: Ai
  EMAIL_RL: RateLimit
  RESEND_API_KEY?: string
  GITHUB_TOKEN?: string
  FROM: string
}

const MODEL = '@cf/meta/llama-3.2-3b-instruct'
const isEmail = (s: unknown): s is string =>
  typeof s === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length < 200
const cleanRepo = (s: unknown): string | null => {
  const r = String(s ?? '')
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\/+$/, '')
  return /^[\w.-]+\/[\w.-]+$/.test(r) ? r : null
}
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  })
const escapeHtml = (s: string) =>
  s.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m] as string)

interface Issue {
  number: number
  title: string
  user?: { login?: string }
  pull_request?: unknown
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname.replace(/\/+$/, '') || '/agent'
    const newNominee = (audit: unknown[]) =>
      new Nominee({
        // nominee brokers BOTH service credentials; the agent code never holds them
        strategy: ({ connection }) =>
          connection === 'github'
            ? (env.GITHUB_TOKEN ?? '')
            : connection === 'resend'
              ? (env.RESEND_API_KEY ?? '')
              : `mock-${connection}`,
        onApprovalRequest: () => {},
        onAudit: (e) => audit.push(e),
        agent: 'digest-agent',
      })

    try {
    // 1) PLAN: fetch the repo's real open issues and draft a digest email
    if (request.method === 'POST' && path.endsWith('/plan')) {
      const { to, repo: repoRaw } = (await request.json().catch(() => ({}))) as {
        to?: string
        repo?: string
      }
      if (!isEmail(to)) return json({ ok: false, reason: 'invalid_email' }, 400)
      const repo = cleanRepo(repoRaw)
      if (!repo) return json({ ok: false, reason: 'invalid_repo', message: 'Use owner/repo' }, 400)

      const audit: unknown[] = []
      const nominee = newNominee(audit)
      const ghToken = await nominee.token({ user: to, connection: 'github' }) // brokered (may be empty)

      const gh = await fetch(
        `https://api.github.com/repos/${repo}/issues?state=open&per_page=6&sort=updated`,
        {
          headers: {
            'user-agent': 'nominee-demo',
            accept: 'application/vnd.github+json',
            ...(ghToken ? { authorization: `Bearer ${ghToken}` } : {}),
          },
        },
      )
      if (!gh.ok) {
        const reason = gh.status === 404 ? 'repo_not_found' : gh.status === 403 ? 'github_rate_limited' : 'github_error'
        return json({ ok: false, reason, status: gh.status, audit }, 502)
      }
      const issues = ((await gh.json()) as Issue[]).filter((i) => !i.pull_request).slice(0, 6)
      if (!issues.length)
        return json({ ok: true, proposal: { to, repo, subject: `No open issues in ${repo}`, body: `Good news — ${repo} currently has no open issues.`, issues: [] }, audit })

      const list = issues.map((i) => `#${i.number} ${i.title}`).join('\n')
      const workersai = createWorkersAI({ binding: env.AI })
      const { text } = await generateText({
        model: workersai(MODEL),
        system:
          'You write a concise, friendly email body (3-5 sentences). No subject line, no greeting, no signature. Summarize the themes of the issues; do not list them all verbatim.',
        prompt: `Summarize these open GitHub issues for ${repo} into a short email body:\n${list}`,
      })
      return json({
        ok: true,
        proposal: {
          to,
          repo,
          subject: `Open-issue digest — ${repo}`,
          body: text.trim(),
          issues: issues.map((i) => ({ number: i.number, title: i.title })),
          authedFetch: Boolean(ghToken),
        },
        audit,
      })
    }

    // 2) EXECUTE: on approval, nominee brokers the email key and we really send
    if (request.method === 'POST' && path.endsWith('/execute')) {
      const b = (await request.json().catch(() => ({}))) as {
        to?: string
        repo?: string
        subject?: string
        body?: string
        decision?: 'approved' | 'denied'
      }
      if (!isEmail(b.to)) return json({ ok: false, reason: 'invalid_email' }, 400)
      const decision = b.decision === 'approved' ? 'approved' : 'denied'
      const audit: unknown[] = []
      const nominee = newNominee(audit)
      nominee.on(() => {})
      // wire approval to the human's decision
      const n2 = new Nominee({
        strategy: ({ connection }) => (connection === 'resend' ? (env.RESEND_API_KEY ?? '') : ''),
        onApprovalRequest: (req) => n2.resolveApproval(req.id, decision),
        onAudit: (e) => audit.push(e),
        agent: 'digest-agent',
      })

      try {
        await n2.approve({ user: b.to, action: 'email.send', detail: { to: b.to, repo: b.repo } })
      } catch {
        return json({ ok: true, decision, sent: false, audit })
      }

      const ip = request.headers.get('cf-connecting-ip') ?? 'anon'
      const { success } = await env.EMAIL_RL.limit({ key: ip })
      if (!success) return json({ ok: false, reason: 'rate_limited', message: 'Too many sends — try again in a minute.' }, 429)

      const key = await n2.token({ user: b.to, connection: 'resend' })
      if (!key) return json({ ok: false, reason: 'not_configured', message: 'RESEND_API_KEY is not set.', audit }, 503)

      const html = `<div style="font-family:system-ui,sans-serif;line-height:1.6">
        <p>${escapeHtml(b.body || '')}</p>
        <hr style="border:none;border-top:1px solid #eee;margin:20px 0" />
        <p style="color:#888;font-size:13px">An AI agent fetched the open issues for <b>${escapeHtml(b.repo || '')}</b>, you approved sending this from the <a href="https://nominee.dev/agent">nominee testbed</a>, and nominee brokered the email-provider key just-in-time.</p></div>`

      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: env.FROM, to: [b.to], subject: b.subject || `Digest — ${b.repo}`, html }),
      })
      const out = (await res.json().catch(() => ({}))) as { id?: string; message?: string }
      if (!res.ok) return json({ ok: false, reason: 'send_failed', status: res.status, detail: out, audit }, 502)
      return json({ ok: true, decision, sent: true, id: out.id, to: b.to, audit })
    }
    } catch (err) {
      return json({ ok: false, reason: 'worker_error', error: String(err) }, 500)
    }

    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
  },
}

const html = /* html */ `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>nominee · live testbed</title>
<link rel="icon" href="https://nominee.dev/assets/icon.svg" type="image/svg+xml" />
<link rel="preconnect" href="https://fonts.googleapis.com" /><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Schibsted+Grotesk:wght@400;500;600&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet" />
<style>
:root{--ink:#0a1020;--raised:#0f1830;--hair:rgba(214,224,245,.12);--paper:#e8ecf6;--soft:#c4ccde;--muted:#7e8ba6;--seal:#d9a441;--sans:'Schibsted Grotesk',system-ui,sans-serif;--mono:'Geist Mono',ui-monospace,monospace}
*{margin:0;box-sizing:border-box}body{font-family:var(--sans);background:radial-gradient(900px 500px at 80% -10%,rgba(217,164,65,.08),transparent 60%),var(--ink);color:var(--paper);min-height:100vh;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:clamp(28px,6vw,64px) 22px 80px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:var(--seal);margin-bottom:14px}
h1{font-size:clamp(28px,5vw,40px);letter-spacing:-.03em;margin-bottom:10px}
.lede{color:var(--muted);margin-bottom:28px}.lede a{color:var(--soft);border-bottom:1px solid var(--hair)}
.card{background:linear-gradient(180deg,var(--raised),#0c1428);border:1px solid var(--hair);border-radius:14px;padding:22px;margin-bottom:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media(max-width:560px){.grid2{grid-template-columns:1fr}}
label{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);display:block;margin-bottom:8px}
input{width:100%;font-family:var(--mono);font-size:15px;color:var(--paper);background:rgba(255,255,255,.03);border:1px solid var(--hair);border-radius:9px;padding:13px 14px}
input:focus{outline:none;border-color:rgba(217,164,65,.5)}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px;align-items:center}
button{font-family:var(--mono);font-size:14px;cursor:pointer;border-radius:9px;padding:12px 18px;border:1px solid var(--hair);background:rgba(255,255,255,.04);color:var(--paper);transition:.15s}
button:hover{border-color:rgba(217,164,65,.5)}button:disabled{opacity:.5;cursor:default}
.primary,.approve{background:var(--seal);color:#1a1205;border-color:var(--seal);font-weight:600}.deny{color:var(--soft)}
.steps{display:flex;gap:8px;font-family:var(--mono);font-size:11px;color:var(--muted);margin-bottom:18px;flex-wrap:wrap}
.steps b{color:var(--seal);font-weight:500}
.issues{font-family:var(--mono);font-size:12.5px;color:var(--soft);margin:6px 0 2px}.issues div{padding:3px 0}.issues .n{color:var(--muted)}
.draft{font-family:var(--mono);font-size:13.5px;background:#070c18;border:1px solid var(--hair);border-radius:10px;padding:14px;margin-top:10px}
.draft .s{color:var(--paper)}.draft .b{color:var(--soft);white-space:pre-wrap;display:block;margin-top:8px}
.log{font-family:var(--mono);font-size:13.5px;line-height:1.95;white-space:pre-wrap}
.log .m{color:var(--muted)}.log .ok{color:#7fd1a6}.log .err{color:#ff6b6b}.log .ac{color:var(--seal)}
.sub{font-size:13px;color:var(--muted);margin-top:8px}
.jsontoggle{font-family:var(--mono);font-size:12px;color:var(--muted);background:none;border:none;border-bottom:1px solid var(--hair);padding:0 0 2px;border-radius:0;margin-top:16px}
pre{font-family:var(--mono);font-size:12px;color:var(--soft);background:#070c18;border:1px solid var(--hair);border-radius:10px;padding:14px;overflow:auto;margin-top:10px;max-height:300px}
.foot{margin-top:28px;font-family:var(--mono);font-size:12px;color:var(--muted);text-align:center}.foot a{color:var(--soft)}
.spin{display:inline-block;color:var(--seal)}
</style></head><body>
<div class="wrap">
  <p class="eyebrow">Live testbed · Cloudflare Workers AI</p>
  <h1>A real agent, acting on your behalf.</h1>
  <p class="lede">It reads a GitHub repo's live open issues, drafts a digest, waits for <strong>your</strong> approval, then emails it to you — nominee brokers the GitHub <em>and</em> email credentials, the agent never holds them. <a href="https://nominee.dev">← nominee.dev</a></p>
  <div class="steps">① <b>read GitHub</b> (token via nominee) → ② draft → ③ <b>your approval</b> → ④ <b>send email</b> (key via nominee) → ⑤ audit</div>

  <div class="card">
    <div class="grid2">
      <div><label for="repo">GitHub repo</label><input id="repo" type="text" value="vercel/ai" /></div>
      <div><label for="to">Email the digest to</label><input id="to" type="email" placeholder="you@example.com" /></div>
    </div>
    <div class="row"><button id="run" class="primary">Read issues & draft ▸</button><span id="status" class="sub"></span></div>
  </div>

  <div id="proposal" class="card" hidden></div>
  <div id="result" class="card" hidden></div>
  <p class="foot">Live GitHub data · sends only to the address you enter · rate-limited · demo-marked. <a href="https://github.com/bharath31/nominee">source ↗</a></p>
</div>
<script>
const $=s=>document.querySelector(s); let J={};
async function api(p,b){const r=await fetch('/agent'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});return r.json()}
function esc(s){return String(s).replace(/[&<>]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[m]))}
function jb(){return '<button class="jsontoggle" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden">show JSON</button><pre hidden>'+esc(JSON.stringify(J,null,2))+'</pre>'}
function line(c,t){return '<div><span class="'+c+'">'+esc(t)+'</span></div>'}
$('#run').addEventListener('click',run)

async function run(){
  const to=$('#to').value.trim(), repo=$('#repo').value.trim()
  if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(to)){$('#status').textContent='enter a valid email';return}
  $('#run').disabled=true; $('#status').innerHTML='<span class="spin">●</span> reading issues & drafting…'
  $('#proposal').hidden=true; $('#result').hidden=true
  const res=await api('/plan',{to,repo}); J={plan:res}
  $('#run').disabled=false; $('#status').textContent=''
  if(!res.ok){$('#proposal').hidden=false;$('#proposal').innerHTML='<span class="log err">✗ '+esc(res.message||res.reason||'error')+'</span>'+jb();return}
  const p=res.proposal
  let iss=(p.issues||[]).map(i=>'<div><span class="n">#'+i.number+'</span> '+esc(i.title)+'</div>').join('')||'<div class="n">no open issues</div>'
  $('#proposal').hidden=false
  $('#proposal').innerHTML=
    '<label>Live issues fetched from '+esc(p.repo)+(p.authedFetch?' (authed via nominee)':'')+'</label><div class="issues">'+iss+'</div>'+
    '<label style="margin-top:16px">Agent wants to email '+esc(p.to)+'</label>'+
    '<div class="draft"><span class="s">'+esc(p.subject)+'</span><span class="b">'+esc(p.body)+'</span></div>'+
    '<p class="sub">Sending email is a sensitive action — nominee is holding it for your approval.</p>'+
    '<div class="row"><button class="approve" id="ap">✓ Approve & send</button><button class="deny" id="dn">Deny</button></div>'+jb()
  $('#ap').onclick=()=>decide(p,'approved'); $('#dn').onclick=()=>decide(p,'denied')
}
async function decide(p,decision){
  $('#ap').disabled=true;$('#dn').disabled=true
  if(decision==='approved')$('#ap').innerHTML='<span class="spin">●</span> sending…'
  const res=await api('/execute',{to:p.to,repo:p.repo,subject:p.subject,body:p.body,decision}); J.execute=res
  $('#result').hidden=false
  let log=line('m','$ approval '+decision)
  if(decision==='approved'&&res.sent){
    log+=line('ac','⚸ approval required — you approved')
    log+=line('ok','✓ nominee brokered the email key (agent never saw it)')
    log+=line('ok','✓ digest emailed to '+esc(res.to)+'  ·  id '+esc(res.id||''))
    log+=line('m','check your inbox ✉')
  } else if(decision==='denied'){ log+=line('err','✗ denied — nothing sent') }
  else { log+=line('err','✗ '+esc(res.message||res.reason||'not sent')) }
  log+='\\n'+line('m','audit  '+((res.audit||[]).map(e=>e.type).join(' → ')||'—'))
  $('#result').innerHTML='<label>Result</label><div class="log">'+log+'</div>'+jb()
  $('#ap').innerHTML='✓ Approve & send'
}
</script></body></html>`
