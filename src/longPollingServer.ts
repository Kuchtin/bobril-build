import * as http from 'http';
import * as crypto from 'crypto';

export interface ILongPollingConnection {
    onMessage: (connection: ILongPollingConnection, message: string, data: any) => void;
    onClose: (connection: ILongPollingConnection) => void;
    userAgent: string;
    send(message: string, data: any): void;
    close(): void;
}

function newRandomId(): string {
    return crypto.randomBytes(20).toString("base64");
}

export class Connection implements ILongPollingConnection {
    onMessage: (connection: ILongPollingConnection, message: string, data: any) => void;
    onClose: (connection: ILongPollingConnection) => void;
    userAgent: string;

    owner: LongPollingServer;
    id: string;
    closed: boolean;
    response: http.ServerResponse;
    timeOut: NodeJS.Timer;
    toSend: { m: string, d: any }[];

    constructor(owner: LongPollingServer) {
        this.owner = owner;
        this.id = newRandomId();
        this.closed = false;
        this.timeOut = null;
        this.toSend = [];
        this.userAgent = "";
        this.reTimeout();
    }

    reTimeout() {
        if (this.timeOut !== null)
            clearTimeout(this.timeOut);
        this.timeOut = setTimeout(this.handleTimeOut, 15000, this);
    }

    handleTimeOut(that: Connection) {
        that.timeOut = null;
        if (that.response == null) {
            that.close();
        }
    }

    send(message: string, data: any): void {
        this.toSend.push({ m: message, d: data });
        if (this.response != null && this.toSend.length === 1) setImmediate(this.sendResponse, this);
    }

    receivedMessage(message: string, data: any) {
        if (this.onMessage != null)
            this.onMessage(this, message, data);
    }

    close(): void {
        if (this.timeOut !== null) {
            clearTimeout(this.timeOut);
            this.timeOut = null;
        }
        if (this.closed == false) {
            if (this.onClose != null)
                this.onClose(this);
        }
        this.closed = true;
        if (this.response != null) {
            this.response.end(JSON.stringify({ id: this.id, close: true }));
            this.response = null;
        }
    }

    sendResponse(that: Connection) {
        if (that.response != null) {
            that.pollResponse(that.response, false);
        }
    }

    pollResponse(response: http.ServerResponse, waitAllowed: boolean) {
        if (this.closed) {
            response.end(JSON.stringify({ id: this.id, close: true }));
        } else if (this.toSend.length > 0) {
            response.end(JSON.stringify({ id: this.id, m: this.toSend }));
            this.toSend = [];
        } else if (waitAllowed) {
            if (this.response != null && this.response !== response) {
                this.response.end(JSON.stringify({ id: this.id, old: true }));
                this.response = null;
            }
            this.response = response;
            return;
        } else {
            response.end(JSON.stringify({ id: this.id }));
        }
        if (this.response === response) {
            this.response = null;
            this.reTimeout();
        }
    }

    closeResponse(response: http.ServerResponse) {
        if (this.response === response) {
            this.response = null;
            this.reTimeout();
        }
    }
}

export class LongPollingServer {
    onConnect: (connection: ILongPollingConnection) => void;
    cs: { [id: string]: Connection };

    constructor(onConnect: (connection: ILongPollingConnection) => void) {
        this.onConnect = onConnect;
        this.cs = Object.create(null);
    }

    handle(request: http.ServerRequest, response: http.ServerResponse) {
        if (request.method != 'POST') {
            response.writeHead(405, "Only POST allowed");
            response.end();
            return;
        }
        var jsonString = '';
        request.on('data', function (data) {
            if (jsonString.length + data.length > 1e6)
                request.connection.destroy();
            jsonString += data;
        });
        request.on('end', () => {
            var data;
            try {
                data = JSON.parse(jsonString);
            } catch (err) {
                response.writeHead(400, "JSON parse error " + err);
                response.end();
                return;
            }
            let c: Connection = null;
            if (data.id) {
                c = this.cs[data.id];
            }
            let waitAllowed = true;
            if (c == null) {
                c = new Connection(this);
                this.cs[c.id] = c;
                this.onConnect(c);
                waitAllowed = false;
            }
            let ua = request.headers['user-agent'];
            if (ua) c.userAgent = ua;
            if (data.close) {
                c.close();
                waitAllowed = false;
            }
            if (Array.isArray(data.m)) {
                waitAllowed = false;
                let ms = data.m as any[];
                setTimeout(() => {
                    for (let i = 0; i < ms.length; i++) {
                        if (c.closed) break;
                        c.receivedMessage(ms[i].m, ms[i].d);
                    }
                }, 0);
            }
            c.pollResponse(response, waitAllowed);
            request.on('close', () => {
                c.closeResponse(response);
            });

        });
    }
}
