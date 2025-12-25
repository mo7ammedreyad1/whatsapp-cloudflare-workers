import { ExecutionContext, KVNamespace } from "@cloudflare/workers-types"
import makeWASocket, { 
    fetchLatestBaileysVersion, 
    makeCacheableSignalKeyStore, 
    useMultiFileAuthState 
} from "../src"

// @ts-ignore
import registerWhatsappHtml from './registerWhatsappHtml.html'
// @ts-ignore
import sendMessageHtml from './sendMessageHtml.html'

export type envData = {
    KV_whatsappCloudflareWorkers: KVNamespace;
}

// كائن Logger بسيط بديل لـ Pino لمنع الانهيار
const silentLogger = { 
    level: 'silent', 
    log: () => {}, debug: () => {}, info: () => {}, 
    warn: () => {}, error: () => {}, trace: () => {},
    child: () => silentLogger 
};

export default {
    async fetch(request: Request, env: envData, ctx: ExecutionContext): Promise<Response> {
        const newUrl = new URL(request.url)
        const pathName = newUrl.pathname
        const prefixUserBot = 'userBot'
        const PASSWORD_ADMIN = '123456' 

        // 1. عرض صفحات الواجهة (HTML)
        if (pathName.startsWith('/site/register-whatsapp') || pathName === '/') {
            return new Response(registerWhatsappHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html' }
            })
        }

        if (pathName.startsWith('/site/send-message')) {
            return new Response(sendMessageHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html' }
            })
        }

        // 2. توليد QR Code (POST)
        if (pathName.startsWith('/api/register-whatsapp') && request.method === 'POST') {
            try {
                const requestBody = await request.json() as { userBot: string; adminPassword: string }
                if (requestBody.adminPassword !== PASSWORD_ADMIN) return new Response('Unauthorized', { status: 401 })

                const userBotPath = `${prefixUserBot}/${requestBody.userBot}`
                const result = await apiRegisterWhatsapp(userBotPath, env.KV_whatsappCloudflareWorkers)

                if (!result) return new Response(JSON.stringify({ error: "QR Error" }), { status: 400 })

                ctx.waitUntil(new Promise(r => setTimeout(async () => {
                    try { await result.sock.ws.close() } catch(e) {}
                    r(null);
                }, 50000)));

                return new Response(JSON.stringify({ link: result.link }), {
                    headers: { 'Content-Type': 'application/json' }
                })
            } catch (e: any) {
                return new Response(JSON.stringify({ error: e.message }), { status: 500 })
            }
        }

        // 3. جلب قائمة البوتات (GET) - تم إصلاح هذا المسار
        if (pathName.startsWith('/api/get-all-user-bot')) {
            const list = await env.KV_whatsappCloudflareWorkers.list({ prefix: `${prefixUserBot}/` })
            const keys = list.keys.map(k => k.name.replace(`${prefixUserBot}/`, '').replace('/creds.json', ''))
            const uniqueKeys = [...new Set(keys)].filter(k => k !== "");
            
            return new Response(JSON.stringify(uniqueKeys), {
                headers: { 'Content-Type': 'application/json' }
            })
        }

        // 4. إرسال رسالة (POST)
        if (pathName.startsWith('/api/send-message') && request.method === 'POST') {
            try {
                const body = await request.json() as any
                if (body.adminPassword !== PASSWORD_ADMIN) return new Response('Unauthorized', { status: 401 })

                const userBotPath = `${prefixUserBot}/${body.userBot}`
                const success = await apiSendMessage(userBotPath, body.phone, body.message, env.KV_whatsappCloudflareWorkers)
                
                return new Response(success ? 'Sent' : 'Failed', { status: success ? 200 : 400 })
            } catch (e) {
                return new Response('Error', { status: 500 })
            }
        }

        return new Response('Not Found', { status: 404 })
    }
}

// دالة التسجيل (محدثة)
async function apiRegisterWhatsapp(userBot: string, storage: KVNamespace) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(userBot, storage as any)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            logger: silentLogger as any,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
            }
        })

        return new Promise((resolve, reject) => {
            const t = setTimeout(() => reject(new Error("Timeout")), 40000)
            sock.ev.on('connection.update', (up) => {
                if (up.qr) { clearTimeout(t); resolve({ sock, link: up.qr }) }
            })
            sock.ev.on('creds.update', saveCreds)
        }) as Promise<any>
    } catch { return null }
}

// دالة الإرسال (محدثة بدون مكتبات ضارة)
async function apiSendMessage(userBot: string, phone: string, message: string, storage: KVNamespace) {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(userBot, storage as any)
        const { version } = await fetchLatestBaileysVersion()
        const sock = makeWASocket({
            version,
            logger: silentLogger as any,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
            }
        })
        sock.ev.on('creds.update', saveCreds)
        await new Promise(r => setTimeout(r, 3000)) // انتظار الربط
        await sock.sendMessage(`${phone}@s.whatsapp.net`, { text: message })
        return true
    } catch { return false }
}
