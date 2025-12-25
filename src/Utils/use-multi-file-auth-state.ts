import { KVNamespace } from '@cloudflare/workers-types'
import { AuthenticationCreds, AuthenticationState, SignalDataTypeMap } from '../Types'
import { initAuthCreds } from './auth-utils'
import { BufferJSON } from './generics'

export const useMultiFileAuthState = async (folder: string, kv: KVNamespace): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => {
    
    // دالة دمج المسارات بدون الاعتماد على مكتبة path
    const fixFileName = (file?: string) => file?.replace(/\//g, '__')?.replace(/:/g, '-');
    const getPath = (file: string) => `${folder}/${fixFileName(file)}`;

    const writeData = async (data: any, file: string) => {
        try {
            const filePath = getPath(file);
            const dataString = JSON.stringify(data, BufferJSON.replacer);
            await kv.put(filePath, dataString);
        } catch (err) {
            console.error("KV Write Error:", err);
        }
    };

    const readData = async (file: string) => {
        try {
            const filePath = getPath(file);
            const data = await kv.get(filePath);
            if (!data) return null;
            return JSON.parse(data, BufferJSON.reviver);
        } catch (err) {
            console.error("KV Read Error:", err);
            return null;
        }
    };

    const removeData = async (file: string) => {
        try {
            await kv.delete(getPath(file));
        } catch (err) {
            console.error("KV Delete Error:", err);
        }
    };

    // تحميل بيانات الاعتماد
    const creds: AuthenticationCreds = await readData('creds.json') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data: { [_: string]: SignalDataTypeMap[typeof type] } = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}.json`);
                            if (type === 'app-state-sync-key' && value) {
                                // التوافق مع Baileys
                                // value = proto.Message.AppStateSyncKeyData.fromObject(value)
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
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
            await writeData(creds, 'creds.json');
        }
    };
};
