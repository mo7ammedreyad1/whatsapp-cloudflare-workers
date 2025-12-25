import { join } from 'path'
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'
import { KVNamespace } from '@cloudflare/workers-types' 
import { credsJsonStatus, logForDevelopment } from '..'

export const useMultiFileAuthState = async(folder: string, KVStorage: KVNamespace): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => { 
	
	const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-')

	const writeData = async (data: any, file: string) => {
		const filePath = join(folder, fixFileName(file)!)
		const dataFormatted = JSON.stringify(data, BufferJSON.replacer)
		
		if (logForDevelopment.show) console.log('KV Write:', filePath)

		// في KV بنستخدم put مباشرة وبنخزن الميتا داتا كـ JSON لو احتجنا
		// الـ KV لا يدعم customMetadata بنفس طريقة R2، هنخزن البيانات بس
		await KVStorage.put(filePath, dataFormatted)
		
		credsJsonStatus.update = true
	}

	const readData = async(file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)
			if (logForDevelopment.show) console.log('KV Read:', filePath)

			const data = await KVStorage.get(filePath)
			if (!data) return null

			return JSON.parse(data, BufferJSON.reviver)
		} catch(error) {
			return null
		}
	}

	const removeData = async(file: string) => {
		try {
			const filePath = join(folder, fixFileName(file)!)
			await KVStorage.delete(filePath)
		} catch {}
	}

	const creds: AuthenticationCreds = await readData('creds.json') || initAuthCreds()

	return {
		state: {
			creds,
			keys: {
				get: async(type, ids) => {
					const data: { [_: string]: SignalDataTypeMap[typeof type] } = { }
					ids.map(id => {
						data[id] = null as any
					})
					return data
				},
				set: async(data) => {
					return void 0 
				}
			}
		},
		saveCreds: async () => { 
			return await writeData(creds, 'creds.json') 
		}
	}
}
