import { EventEmitter as event_emitter } from 'events'
import { createServer, Server as http_server } from 'http'
import my_server_socket, { IConfig, ISocketInfo, get_hash_id } from './server_websocket';
import * as ws from 'ws';
import { create_debug } from './utils'

const debug = create_debug('ws_node');
const PING_TIMEOUT_MS = 200;
const RECONNECT_TO_LOST_ATTEMPTS = 5;
const RECONNECT_TIMEOUT = 800;

export function parseAddressString(str: string) {
    const address = str.split(/\s+/g);
    const result = address.reduce((acc: IConfig[], addr: string): IConfig[] => {
        let [address, port] = addr.split(':');
        acc.push({ address, port: parseInt(port) });

        return acc;
    }, []);

    return result;
}

export default class ws_node extends event_emitter {
    config: IConfig;
    server: http_server;
    socket: my_server_socket;

    second_start: number;
    clients_for_iteration: Set<ws> = new Set<ws>();


    constructor(config: IConfig) {
        super();

        this.config = Object.assign({ nodeId: 0 }, config);
    }

    public static get_websocket_url(config: IConfig) {
        return `ws://${config.address}:${config.port}`;
    }

    private on_server_error(error: Error) {
        console.error(error.toString());

        this.config.port++;
        this.listen();
    }

    private on_server_listening(callback?: Function) {
        debug(`Server listening on ${this.config.address}:${this.config.port}, ws attached`);

        this.socket = new my_server_socket(this.server)
        .on('disconnect', (client) => this.on_websocket_disconnect(client))
        .on('connection', (client, info) => this.on_client_connection(client, info))
        .on('command', (command, value, client, info, obj) => this.on_client_command(command, value, client, info, obj))
        .on('message', (obj, client, info) => this.on_client_message(obj, client, info))
        .on('ping', (client, info) => this.on_client_socket_ping(client, info))
        .on('pong', (client, info) => this.on_client_socket_pong(client, info))
        .on('ping_start', () => this.on_websocket_ping_start());

        callback && callback(this);
    }

    private listen() {
        this.server.listen(this.config.port, this.config.address);
    }

    private on_websocket_disconnect(client: ws) {
        debug('WS disconnected');
    }

    private on_websocket_ping_start() {
        // debug(`WS ping start`);

        this.second_start = new Date().getTime();
        this.clients_for_iteration.clear();
        setTimeout(() => this.on_ping_timed_out(), PING_TIMEOUT_MS);
    }

    private on_client_connection(client: ws, info: ISocketInfo) {
        debug(`WS connecting`, JSON.stringify(info.data));

        // Trying to setup reconnection policy, but now I do not understand what I mean last night.

        // let attempt = 0;
        // const { address, port } = get_socket_address_and_port(client);
        // const worker = () => {
        //     if (!this.socket.has_connection(address, port)) {
        //         this.connect(address, port);
        //         attempt++;

        //         if (attempt < RECONNECT_TO_LOST_ATTEMPTS) {
        //             setTimeout(() => worker, RECONNECT_TIMEOUT);
        //         }
        //     }
        // }

        // setTimeout(() => worker, RECONNECT_TIMEOUT);
    }

    private on_client_command(command: string, value: any, client: ws, info: ISocketInfo, obj: any) {
        switch(command) {
            case 'node':
                this.on_client_command_node(value, client, info);
                break;
            case 'node_response':
                this.on_client_command_node_response(client, value, info);
                break;
                case 'ready':
                this.on_client_command_ready(client, info);
                break;
            case 'ready_response':
                this.on_client_command_ready_response(client, info);
                break;
            default:
                debug(`WS UNKNOWN command: ${command}`, JSON.stringify(info.data), JSON.stringify(value));
        }
    }

    private on_client_message(obj: any, client: ws, info: ISocketInfo) {
        debug(`WS message:`, JSON.stringify(info.data), JSON.stringify(obj));
    }

    private on_client_socket_ping(client: ws, info: ISocketInfo) {
        // debug(`CLIENT ping:`, JSON.stringify(info.data));
    }

    private on_client_socket_pong(client: ws, info: ISocketInfo) {
        // debug(`CLIENT pong:`, JSON.stringify(info.data));

        if (this.second_start + PING_TIMEOUT_MS > new Date().getTime()) {
            if (info.data && info.data.ready) {
                this.clients_for_iteration.add(client);
            }
        }
    }

    private on_ping_timed_out() {
        // debug(`Ping timed out, on this second working with ${this.clients_for_iteration.size} clients`);

        this.do_work();
    }

    private on_client_command_node(config: IConfig, client: ws, info: ISocketInfo) {
        const result_client_list = this.get_connections([config]);
        this.socket.set_client_data(client, { config });

        debug(`WS command "node" from client ${JSON.stringify(info.data)}, sending our neighborhoods ${JSON.stringify(result_client_list)}`);

        this.socket.send_command(client, 'node_response', result_client_list);
    }

    private on_client_command_node_response(client: ws, nodes_list: IConfig[], info: ISocketInfo) {
        let has_new_node = false;

        nodes_list.forEach(node => {
            if (!this.socket.has_connection(node.address, node.port)) {
                has_new_node = true;
                if (node.nodeId > this.config.nodeId) {
                    this.config.nodeId = node.nodeId + 1;
                }
                this.connect(node.address, node.port);
            }
        });

        debug(`WS command "node_response" from client ${JSON.stringify(info.data)}, has${has_new_node ? '' : "n't"} new nodes to connect to${has_new_node ? '' : ', sending "ready" to all.'}`);

        if (!has_new_node) {
            const clients = this.get_clients(false);
            clients.forEach((client: ws) => {
                this.socket.send_command(client, 'ready', { nodeId: this.config.nodeId });
            });
        }
    }

    private on_client_command_ready(client: ws, info: ISocketInfo) {
        debug(`WS command "ready" from client ${JSON.stringify(info.data)}, including node to workes list and send "ready_response" back`);

        this.socket.set_client_data(client, { ready: true });
        this.socket.send_command(client, 'ready_response');
    }

    private on_client_command_ready_response(client: ws, info: ISocketInfo) {
        debug(`WS command "ready_response" from client ${JSON.stringify(info.data)}, including node to workes list`);

        this.socket.set_client_data(client, { ready: true });
    }

    private get_connections(except: IConfig[]): IConfig[] {
        const result_socket_info: IConfig[] = Array.from(this.clients_for_iteration).map(client => {
            const info = this.socket.get_client_info(client);
            return info && info.data && info.data.config;
        }).filter(client_config => {
            return client_config && !except.some(config => config.address === client_config.address && config.port === client_config.port);
        });

        return result_socket_info;
    }

    public do_work() {
        debug(`WS do actual work with ${this.clients_for_iteration.size} (ready clients: ${this.get_clients().length}) clients`);
    }

    public start_server(callback?: Function) {
        this.server = createServer()
        .on('error', (error) => this.on_server_error(error))
        .on('listening', () => this.on_server_listening(callback));

        this.listen();
    }

    public connect(address: string, port: number) {
        const config = { address, port };
        const url = ws_node.get_websocket_url(config);
        const client = new ws(url)
        .on('open', () => {
            this.socket.send_command(client, 'node', this.config);
        })
        .on('error', error => {
            console.log(`Error: ${error}`);
        });
        this.socket.add_client(client, { config });
    }

    public get_clients(only_ready = true): ws[] {
        return Array.from(this.socket.clients).filter(client => {
            if (only_ready) {
                const info = this.socket.get_client_info(client);
                return info && info.data && info.data.ready;
            } else {
                return true;
            }
        })
    }
}
