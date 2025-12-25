import { KVNamespace } from '@cloudflare/workers-types'
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

/**
 * نسخة معدلة لتعمل مع Cloudflare KV بدلاً من R2
 */
export const useMultiFileAuthState = async (
    folder: string, 
    kv: KVNamespace
): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => {

    // دالة مساعدة لدمج المسارات بدون الحاجة لمكتبة 'path'
    const safeJoin = (f: string, filename: string) => `${f}/${filename.replace(/\//g, '__').replace(/:/g, '-')}`;

    // 1. دالة الكتابة في الـ KV
    const writeData = async (data: any, file: string) => {
        const filePath = safeJoin(folder, file);
        try {
            console.log(`[KV Write] Attempting to write: ${filePath}`);
            const dataFormatted = JSON.stringify(data, BufferJSON.replacer);
            
            // في KV نستخدم put مباشرة
            await kv.put(filePath, dataFormatted);
            
            console.log(`[KV Write] Successfully saved: ${filePath}`);
        } catch (error: any) {
            console.error(`[KV Write ERROR] Failed to write ${filePath}:`, error.message);
            throw error;
        }
    }

    // 2. دالة القراءة من الـ KV
    const readData = async (file: string) => {
        const filePath = safeJoin(folder, file);
        try {
            console.log(`[KV Read] Reading: ${filePath}`);
            const data = await kv.get(filePath);

            if (!data) {
                console.log(`[KV Read] No data found for: ${filePath}`);
                return null;
            }

            const parsedData = JSON.parse(data, BufferJSON.reviver);
            console.log(`[KV Read] Success: ${filePath}`);
            return parsedData;
        } catch (error: any) {
            console.error(`[KV Read ERROR] Failed to read ${filePath}:`, error.message);
            return null;
        }
    }

    // 3. دالة الحذف من الـ KV
    const removeData = async (file: string) => {
        const filePath = safeJoin(folder, file);
        try {
            console.log(`[KV Delete] Removing: ${filePath}`);
            await kv.delete(filePath);
        } catch (error: any) {
            console.error(`[KV Delete ERROR] Failed to delete ${filePath}:`, error.message);
        }
    }

    // تهيئة البيانات الأساسية (creds.json)
    console.log("[Auth Init] Checking for existing credentials...");
    const creds: AuthenticationCreds = await readData('creds.json') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    console.log(`[Keys Get] Fetching keys for type: ${type}`);
                    const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
                    
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                // هنا يمكن إضافة تحويل البروتوكول إذا كان مطلوباً
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    console.log(`[Keys Set] Saving keys...`);
                    const tasks: Promise<void>[] = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: async () => {
            console.log("[Auth] Saving core credentials...");
            return await writeData(creds, 'creds.json');
        }
    }
}
