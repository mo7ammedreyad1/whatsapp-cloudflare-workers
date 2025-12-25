import { ExecutionContext, KVNamespace } from "@cloudflare/workers-types"
// تم إزالة NodeCache و Pino لأنها تسبب Error 500 في Workers
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

export default {
    async fetch(request: Request, env: envData, ctx: ExecutionContext): Promise<Response> {
        const newUrl = new URL(request.url)
        const pathName = newUrl.pathname
        const prefixUserBot = 'userBot'
        const PASSWORD_ADMIN = '123456' 

        // 1. عرض الصفحات (HTML)
        if (pathName.startsWith('/site/register-whatsapp') || pathName === '/') {
            return new Response(registerWhatsappHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html' }
            })
        }

        // 2. معالجة طلب تسجيل واتساب وتوليد QR
        if (pathName.startsWith('/api/register-whatsapp') && request.method === 'POST') {
            try {
                const requestBody = await request.json() as { userBot: string; adminPassword: string }
                let { userBot, adminPassword } = requestBody

                if (adminPassword !== PASSWORD_ADMIN) {
                    return new Response('Unauthorized: Wrong Password', { status: 401 })
                }

                if (!env.KV_whatsappCloudflareWorkers) {
                    return new Response('KV Binding Missing in wrangler.toml', { status: 500 });
                }

                userBot = `${prefixUserBot}/${userBot}`

                // محاولة توليد QR
                const result = await apiRegisterWhatsapp(userBot, env.KV_whatsappCloudflareWorkers)

                if (!result || !result.link) {
                    return new Response(JSON.stringify({ error: "Could not generate QR. Try again." }), { status: 400 })
                }

                // إغلاق الاتصال بعد فترة لتوفير الموارد
                ctx.waitUntil(new Promise(r => setTimeout(async () => {
                    try { await result.sock.ws.close() } catch(e) {}
                    r(null);
                }, 45000)));

                return new Response(JSON.stringify({ link: result.link }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                })

            } catch (error: any) {
                return new Response(JSON.stringify({ error: error.message }), { status: 500 })
            }
        }

        return new Response('Not Found', { status: 404 })
    }
}

// الوظائف المساعدة - تم تنظيفها من مسببات الأخطاء
async function apiRegisterWhatsapp(userBot: string, storage: KVNamespace) {
    try {
        // تم استبدال Logger بكائن بسيط لا يسبب انهيار
        const silentLogger = { 
            level: 'silent', 
            log: () => {}, debug: () => {}, info: () => {}, 
            warn: () => {}, error: () => {}, trace: () => {},
            child: () => silentLogger 
        };

        const { state, saveCreds } = await useMultiFileAuthState(userBot, storage as any)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            logger: silentLogger as any,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, silentLogger as any),
            },
            // تم إزالة NodeCache لأنه يعتمد على مكتبات Node.js المحظورة
            generateHighQualityLinkPreview: false,
        })

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Timeout waiting for QR")), 30000);

            sock.ev.on('connection.update', (update) => {
                const { qr } = update;
                if (qr) {
                    clearTimeout(timeout);
                    resolve({ sock, link: qr });
                }
            });

            sock.ev.on('creds.update', saveCreds);
        }) as Promise<{ sock: any, link: string }>

    } catch (e) {
        console.error("Critical Error:", e);
        return null;
    }
}
