import NodeCache from '@cacheable/node-cache'
import P from 'pino'
import type { Boom } from '@hapi/boom'
import { ExecutionContext, KVNamespace } from "@cloudflare/workers-types"
import makeWASocket, { 
    credsJsonStatus, 
    DisconnectReason, 
    fetchLatestBaileysVersion, 
    logForDevelopment, 
    makeCacheableSignalKeyStore, 
    useMultiFileAuthState 
} from "../src"

// @ts-ignore
import registerWhatsappHtml from './registerWhatsappHtml.html'
// @ts-ignore
import sendMessageHtml from './sendMessageHtml.html'

// تعريف نوع البيانات لـ KV
export type envData = {
    KV_whatsappCloudflareWorkers: KVNamespace;
}

export default {
    async fetch(request: Request, env: envData, ctx: ExecutionContext): Promise<Response> {
        const newUrl = new URL(request.url)
        const pathName = newUrl.pathname
        const prefixUserBot = 'userBot'
        const PASSWORD_ADMIN = '123456' // تأكد من مطابقتها لما تدخله في الواجهة

        console.log(`Incoming request: ${request.method} ${pathName}`);

        // 1. عرض الصفحات (HTML)
        if (pathName.startsWith('/site/register-whatsapp') || pathName === '/') {
            return new Response(registerWhatsappHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
            })
        }

        if (pathName.startsWith('/site/send-message')) {
            return new Response(sendMessageHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
            })
        }

        // 2. معالجة طلب تسجيل واتساب وتوليد QR
        if (pathName.startsWith('/api/register-whatsapp') && request.method === 'POST') {
            try {
                const requestBody = await request.json() as { userBot: string; adminPassword: string }
                let { userBot, adminPassword } = requestBody

                console.log(`Attempting to register bot: ${userBot}`);

                if (adminPassword !== PASSWORD_ADMIN) {
                    console.error("Unauthorized: Incorrect Password");
                    return new Response('Unauthorized', { status: 401 })
                }

                if (!env.KV_whatsappCloudflareWorkers) {
                    console.error("KV Binding Error: KV_whatsappCloudflareWorkers is undefined");
                    return new Response('KV Binding Error', { status: 500 });
                }

                userBot = `${prefixUserBot}/${userBot}`

                // تنظيف الجلسة القديمة من KV
                await env.KV_whatsappCloudflareWorkers.delete(`${userBot}/creds.json`)
                console.log("Old session cleared from KV");

                const sockAndLink = await apiRegisterWhatsapp(userBot, env.KV_whatsappCloudflareWorkers)

                if (!sockAndLink) {
                    console.error("Failed to generate QR Code");
                    return new Response('Error generating QR', { status: 400 })
                }

                const { sock, link } = sockAndLink
                console.log("QR Code generated successfully");

                // إغلاق الاتصال بعد 50 ثانية لتوفير الموارد
                ctx.waitUntil(
                    new Promise((resolve) => {
                        setTimeout(async () => {
                            try {
                                await sock.ws.close()
                                console.log("Socket closed after timeout");
                                resolve(undefined)
                            } catch { resolve(undefined) }
                        }, 50000)
                    })
                )

                return new Response(JSON.stringify({ link }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                })
            } catch (error: any) {
                console.error("API Error:", error.message);
                return new Response('Internal Server Error', { status: 500 })
            }
        }

        // 3. إرسال الرسائل
        else if (pathName.startsWith('/api/send-message') && request.method === 'POST') {
            try {
                const requestBody = await request.json() as { userBot: string; phone: string; message: string; adminPassword: string }
                let { userBot, phone, message, adminPassword } = requestBody

                if (adminPassword !== PASSWORD_ADMIN) return new Response('Unauthorized', { status: 401 })

                userBot = `${prefixUserBot}/${userBot}`
                
                const creds = await env.KV_whatsappCloudflareWorkers.get(`${userBot}/creds.json`)
                if (!creds) return new Response('No session found. Please login first.', { status: 400 })

                const result = await apiSendMessage(userBot, phone, message, env.KV_whatsappCloudflareWorkers)

                if (!result) return new Response('Error sending message', { status: 400 })

                const { sock, successSend } = result
                await sock.ws.close()

                return new Response(successSend ? 'Message sent' : 'Failed to send', { status: successSend ? 200 : 400 })
            } catch (error) {
                return new Response('Error', { status: 500 })
            }
        }

        // 4. جلب قائمة المستخدمين المسجلين
        else if (pathName.startsWith('/api/get-all-user-bot') && request.method === 'GET') {
            const list = await env.KV_whatsappCloudflareWorkers.list({ prefix: `${prefixUserBot}/` })
            // استخراج أسماء الـ bots فقط من المفاتيح
            const keys = list.keys.map(k => k.name.replace(`${prefixUserBot}/`, '').replace('/creds.json', ''))
            const uniqueKeys = [...new Set(keys)]; // إزالة التكرار

            return new Response(JSON.stringify(uniqueKeys), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        }

        return new Response('Not Found', { status: 404 })
    }
}

// الوظائف المساعدة
async function apiRegisterWhatsapp(userBot: string, storage: KVNamespace) {
    try {
        const logger = P({ level: 'silent' })
        const msgRetryCounterCache = new NodeCache()

        // استخدام الـ KV للتخزين
        const { state, saveCreds } = await useMultiFileAuthState(userBot, storage as any)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            msgRetryCounterCache,
        })

        let qrCode: string | undefined = undefined

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("QR Timeout")), 40000);

            sock.ev.process(async (events) => {
                if (events['connection.update']) {
                    const { connection, qr } = events['connection.update']
                    if (qr) {
                        qrCode = qr
                        clearTimeout(timeout)
                        resolve({ sock, link: qrCode })
                    }
                }
                if (events['creds.update']) {
                    await saveCreds()
                }
            })
        }) as Promise<{ sock: any, link: string }>

    } catch (e) {
        console.error("apiRegisterWhatsapp Error:", e);
        return false
    }
}

async function apiSendMessage(userBot: string, phone: string, message: string, storage: KVNamespace) {
    try {
        const logger = P({ level: 'silent' })
        const { state, saveCreds } = await useMultiFileAuthState(userBot, storage as any)
        const { version } = await fetchLatestBaileysVersion()

        const sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
        })

        let successSend = false
        sock.ev.on('creds.update', saveCreds)

        // انتظار الاتصال قبل الإرسال
        await new Promise(r => setTimeout(r, 5000))

        const jid = `${phone}@s.whatsapp.net`
        const sent = await sock.sendMessage(jid, { text: message })
        if (sent) successSend = true

        return { sock, successSend }
    } catch { return false }
}
