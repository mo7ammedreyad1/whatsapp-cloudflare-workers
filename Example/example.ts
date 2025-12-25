import NodeCache from '@cacheable/node-cache'
import P from 'pino'
import type { Boom } from '@hapi/boom'
import { ExecutionContext, KVNamespace } from "@cloudflare/workers-types"
import makeWASocket, { credsJsonStatus, DisconnectReason, fetchLatestBaileysVersion, logForDevelopment, makeCacheableSignalKeyStore, useMultiFileAuthState } from "../src"
// @ts-ignore
import registerWhatsappHtml from './registerWhatsappHtml.html'
// @ts-ignore
import sendMessageHtml from './sendMessageHtml.html'

// تعديل نوع البيانات لاستخدام KV بدلاً من R2
export type envData = {
    KV_whatsappCloudflareWorkers: KVNamespace;
}

export default {
	async fetch(request: Request, env: envData, ctx: ExecutionContext): Promise<Response> {
		const newUrl = new URL(request.url)
		const pathName = newUrl.pathname
		const prefixUserBot = 'userBot'

		// نصيحة: غير كلمة المرور هذه في ملف wrangler.toml أو هنا
		const PASSWORD_ADMIN = '123456'

		logForDevelopment.show = false

		if (pathName.startsWith('/site/register-whatsapp') || pathName === '/') {
            return new Response(registerWhatsappHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
            })
		}

		else if (pathName.startsWith('/site/send-message')) {
            return new Response(sendMessageHtml, {
                status: 200,
                headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' }
            })
		}

		else if (pathName.startsWith('/api/register-whatsapp') && request.method === 'POST') {
			try {
				const requestBody = await request.json() as { userBot: string; adminPassword: string }
				let userBot = requestBody.userBot
				const adminPassword = requestBody.adminPassword

				if (adminPassword !== PASSWORD_ADMIN) {
					return new Response('Unauthorized', {status: 401})
				}

				userBot = `${prefixUserBot}/${userBot}`

				// في KV نقوم بحذف المفتاح (البيانات القديمة)
				await env.KV_whatsappCloudflareWorkers.delete(`${userBot}/creds.json`)

				const sockAndLink = await apiRegisterWhatsapp(userBot, env.KV_whatsappCloudflareWorkers)

				if (!sockAndLink) {
					return new Response('Error generating QR', { status: 400 })
				}

				const { sock, link } = sockAndLink

				ctx.waitUntil(
					new Promise((resolve) => {
						setTimeout(async () => {
							try {
								await sock.ws.close()
								resolve(undefined)
							} catch { resolve(undefined) }
						}, 50000)
					})
				)

				return new Response(JSON.stringify({ link }), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				})
			} catch (error) {
				return new Response('Error', {status: 500})
			}
		}

		else if (pathName.startsWith('/api/send-message') && request.method === 'POST') {
			try {
				const requestBody = await request.json() as { userBot: string; phone: string; message: string; adminPassword: string }
				let { userBot, phone, message, adminPassword } = requestBody

				if (adminPassword !== PASSWORD_ADMIN) return new Response('Unauthorized', {status: 401})

				userBot = `${prefixUserBot}/${userBot}`
				
				// التأكد من وجود الجلسة في الـ KV
				const creds = await env.KV_whatsappCloudflareWorkers.get(`${userBot}/creds.json`)
				if (!creds) return new Response('No session found. Please login first.', {status: 400})

				const result = await apiSendMessage(userBot, phone, message, env.KV_whatsappCloudflareWorkers)

				if(!result) return new Response('Error sending message', {status: 400})

				const { sock, successSend } = result
				await sock.ws.close()

				return new Response(successSend ? 'Message sent' : 'Failed to send', { status: successSend ? 200 : 400 })
			} catch (error) {
				return new Response('Error', {status: 500})
			}
		}

		else if (pathName.startsWith('/api/get-all-user-bot') && request.method === 'GET') {
			// جلب قائمة المستخدمين من KV
			const list = await env.KV_whatsappCloudflareWorkers.list({ prefix: `${prefixUserBot}/` })
			return new Response(JSON.stringify(list.keys), {
				status: 200,
				headers: { 'Content-Type': 'application/json' }
			})
		}

		return new Response('Not Found', {status: 404})
	}
}

// تعديل الوظائف المساعدة لاستقبال KVNamespace بدلاً من R2Bucket
async function apiRegisterWhatsapp(userBot: string, storage: KVNamespace) {
	try {
		const logger = P({ level: 'silent' })
		const msgRetryCounterCache = new NodeCache()
		const dateNow = Date.now()

		const startSock = async () => {
			// ملاحظة: يجب أن تكون مكتبة useMultiFileAuthState تدعم الـ KV أو يتم تعديلها
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

			let qrCode = ''
			sock.ev.process(async (events) => {
				if (events['connection.update']) {
					const { connection, qr } = events['connection.update']
					if (qr) qrCode = qr
				}
				if (events['creds.update']) await saveCreds()
			})

			while (!qrCode) await new Promise(r => setTimeout(r, 1000))
			return { sock, link: qrCode }
		}

		return await startSock()
	} catch { return false }
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

		await new Promise(r => setTimeout(r, 3000))
		const jid = `${phone}@s.whatsapp.net`
		const sent = await sock.sendMessage(jid, { text: message })
		if (sent) successSend = true

		return { sock, successSend }
	} catch { return false }
}
