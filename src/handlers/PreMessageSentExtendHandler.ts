import { HttpStatusCode, IHttp, IMessageExtender, IRead } from '@rocket.chat/apps-engine/definition/accessors';
import { IMessage, IMessageAttachment, IMessageAttachmentField } from '@rocket.chat/apps-engine/definition/messages';
import { getTaskUrl } from '../lib/const';
import { getAccessTokenForUser } from '../storage/users';

const TASK_URL_RE = /https?:\/\/app\.clickup\.com\/(?:[^\s]*?\/)?t\/([a-zA-Z0-9]+)/gi;
const MAX_UNFURLS_PER_MESSAGE = 3;
const DESCRIPTION_LIMIT = 240;

export function extractClickUpTaskIds(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const re = new RegExp(TASK_URL_RE.source, TASK_URL_RE.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        const id = match[1];
        if (!seen.has(id)) {
            seen.add(id);
            ids.push(id);
            if (ids.length >= MAX_UNFURLS_PER_MESSAGE) break;
        }
    }
    return ids;
}

async function fetchTask(http: IHttp, token: string, taskId: string): Promise<any | null> {
    try {
        const response = await http.get(getTaskUrl(taskId), { headers: { Authorization: token } });
        if (response.statusCode === HttpStatusCode.OK) return response.data;
    } catch (_) {}
    return null;
}

function buildAttachment(task: any): IMessageAttachment {
    const fields: IMessageAttachmentField[] = [];

    if (task.status?.status) {
        fields.push({ short: true, title: 'Status', value: String(task.status.status) });
    }
    if (Array.isArray(task.assignees) && task.assignees.length > 0) {
        const names = task.assignees.map((a: any) => a.username || a.email).filter(Boolean).join(', ');
        if (names) fields.push({ short: true, title: 'Assignees', value: names });
    }
    if (task.priority?.priority) {
        fields.push({ short: true, title: 'Priority', value: String(task.priority.priority) });
    }
    if (task.due_date) {
        const ts = Number(task.due_date);
        if (!isNaN(ts)) {
            fields.push({ short: true, title: 'Due', value: new Date(ts).toISOString().slice(0, 10) });
        }
    }

    let text: string | undefined;
    if (typeof task.description === 'string' && task.description.length > 0) {
        text = task.description.length > DESCRIPTION_LIMIT
            ? task.description.slice(0, DESCRIPTION_LIMIT) + '…'
            : task.description;
    }

    const color = typeof task.status?.color === 'string' ? task.status.color : undefined;

    return {
        title: { value: task.name, link: task.url },
        text,
        fields,
        color,
    };
}

export async function handlePreMessageSentExtend(
    message: IMessage,
    extend: IMessageExtender,
    read: IRead,
    http: IHttp,
): Promise<IMessage> {
    if (!message.text || !message.sender) return extend.getMessage();
    const taskIds = extractClickUpTaskIds(message.text);
    if (taskIds.length === 0) return extend.getMessage();

    const auth = await getAccessTokenForUser(read, message.sender);
    if (!auth?.token) return extend.getMessage();

    for (const id of taskIds) {
        const task = await fetchTask(http, auth.token, id);
        if (task) extend.addAttachment(buildAttachment(task));
    }

    return extend.getMessage();
}

export function messageHasClickUpTaskUrl(message: IMessage): boolean {
    return !!message.text && extractClickUpTaskIds(message.text).length > 0;
}
