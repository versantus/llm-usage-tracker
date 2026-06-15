/**
 * Minimal Server-Sent Events hub. Tracks connected dashboard clients and
 * broadcasts JSON messages to all of them.
 */

const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController>();

export function sseResponse(): Response {
    let self: ReadableStreamDefaultController;
    const stream = new ReadableStream({
        start(controller) {
            self = controller;
            clients.add(controller);
            controller.enqueue(encoder.encode(`: connected\n\n`));
        },
        cancel() {
            clients.delete(self);
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        }
    });
}

export function broadcast(event: string, data: unknown): void {
    const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const c of clients) {
        try {
            c.enqueue(payload);
        } catch {
            clients.delete(c);
        }
    }
}

export function clientCount(): number {
    return clients.size;
}
