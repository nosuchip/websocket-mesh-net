import * as ws from 'ws';
import * as crypto from 'crypto';
import * as EventEmitter from 'events';
import { Server, IncomingMessage } from 'http';
import { create_debug } from './utils'

const debug = create_debug('my_websocket');

export interface ISocketInfo {
  lid: string;      // Local client ID exists only inside node, not shared across distributed nodes
  last_seen: number;
  alive: boolean;
  data?: any
}

export interface IConfig {
  nodeId?: string;
  address: string;
  port: number;
}

export function get_random_id(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function get_hash_id(value: any): string {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function not_open(socket: ws) {
  return socket.readyState === ws.CLOSED || socket.readyState === ws.CLOSING;
}

// export function get_socket_address_and_port(client: ws): IConfig {
//   const internal = client['_socket'];

//   if (!internal) return null;

//   return { address: internal.remoteAddress, port: internal.remotePort };
// }

function start_froom_next_whole_second(cb: Function) {
  const start = new Date().getTime();
  const now = new Date().getTime();
  const timeout = Math.ceil(now / 1000) * 1000 - now;

  setTimeout(cb, timeout);

  debug(`Timer setting elapsed time ${new Date().getTime() - start}, timeout: ${timeout}`);
}

class my_server_websocket extends EventEmitter {
  result_socket: Map<ws, ISocketInfo>;
  result_room: Map<string, ws[]>;
  websocket_server: ws.Server;

  constructor(httpServer: Server) {
    super();

    this.result_socket = new Map();
    this.result_room = new Map();
    this.websocket_server = new ws.Server({ server: httpServer });

    this.websocket_server.on('connection', (socket) => this.on_connection(socket));
    this.websocket_server.on('error', (error) => this.on_error(error));
    this.websocket_server.on('close', () => this.on_close());
    this.set_heartbeat();
  }

  emit(event: string, ...args: any[]): boolean {
    const args_to_show = args.map(arg => {
      try {
        return JSON.stringify(arg);
      } catch (error) {
        return arg.constructor.name;
      }
    }).join('; ');

    debug(`Emitting "${event}" with data ${args_to_show}`);
    return super.emit(event, ...args);
  }

  cleanup() {
    for (let [room, result_client] of this.result_room.entries()) {
      let index = result_client.length;

      while (index--) {
        const client = result_client[index];

        if (!this.result_socket.has(client) || !client || not_open(client)) {
          result_client.splice(index, 1);

          this.emit('left_room', room, client, this.result_socket.get(client));

          debug(`removed client #${index} from room ${room}, now its length ${result_client.length}`);
        }
      }
    }
  }

  set_heartbeat() {
    start_froom_next_whole_second(() => {
      setInterval(() => {
        debug('--------------', new Date().toISOString(), '--------------');
        debug('begin cleanup', new Date().toISOString());

        this.emit('ping_start');

        this.cleanup();

        debug('begin clients iteration', new Date().toISOString());

        this.websocket_server.clients.forEach((socket) => {
          const info = this.result_socket.get(socket);
          if (!info || !info.alive) {
            socket.terminate();

            this.websocket_server.clients.delete(socket);
            this.result_socket.delete(socket);

            this.emit('disconnect', socket);

            debug(`client ${info && info.lid} didn't responded on ping in time and was terminated`);

            return;
          }

          info.alive = false;

          try {
            socket.ping();
            this.emit('ping', socket, info);

            debug(`send ping to ${info.lid}...`);
          }
          catch (error) {
            debug(`unable to ping client ${info.lid}: ${error}`);
          }
        });
        debug('done', new Date().toISOString());
      }, 1000);
    });
  }


  prepare_payload(payload: ws.Data) {
    return JSON.stringify(payload);
  }

  on_connection(socket: ws, data?: any) {
    const info: ISocketInfo = {
      lid: get_random_id(),
      last_seen: new Date().getTime(),
      alive: true,
      data: data || {}
    };

    this.result_socket.set(socket, info);

    debug(`connection, socket_id: ${info.lid}`);

    socket.on('pong', () => this.on_pong(socket));
    socket.on('message', (data: string) => this.on_message(data, socket));
    this.emit('connection', socket, info);
  }

  on_error(error: Error) {
    debug(`error '${error}'`);

    this.emit('error', error);
  }

  on_close() {
    debug('close');
  }

  on_pong(socket: ws) {
    const info = this.result_socket.get(socket);

    if (info) {
      info.alive = true;
      info.last_seen = new Date().getTime();

      this.emit('pong', socket, info);
      debug(`client ${info.lid} responded on ping`);
    }
  }

  on_message(data: string, socket: ws) {
    try {
      const obj = JSON.parse(data);
      const command = obj['__command__'];

      if (command) {
        const value = obj['__value__'];

        debug(`command received: ${data}`);

        switch (command) {
          case 'join_room':
            this.join_room(value, socket);
            break;
          case 'leave_room':
            this.leave_room(value, socket);
            break;
          default:
            this.emit('command', command, value, socket, this.result_socket.get(socket), obj);
        }
      }
      else {
        debug(`message received: ${data}`);

        this.emit('message', obj, socket, this.result_socket.get(socket));
      }
    }
    catch (error) {
      debug(`unable to parse incoming message: '${data}'`);
    }
  }

  join_room(room: string, socket: ws) {
    if (!this.result_room.has(room)) {
      this.result_room.set(room, [socket]);
      socket.send(JSON.stringify({topic: 'joined room', room}));

      this.emit('joined_room', room, socket, this.result_socket.get(socket));

      debug(`socket_id: ${this.result_socket.get(socket).lid} joined to room ${room}`);
    }
    else {
      const result_client = this.result_room.get(room);

      if (result_client && result_client.indexOf(socket) === -1) {
          result_client.push(socket);
          socket.send(JSON.stringify({topic: 'joined room', room}));

          this.emit('joined_room', room, socket, this.result_socket.get(socket));

          debug(`socket_id: ${this.result_socket.get(socket).lid} joined to room ${room}`);
      }
    }
  }

  leave_room(room: string, socket: ws) {
    const result_client = this.result_room.get(room);

    if (!result_client)
      return;

    const index = result_client.indexOf(socket);

    if (index !== -1) {
      result_client.splice(index, 1);
      this.emit('left_room', room, socket, this.result_socket.get(socket));

      if (result_client.length === 0) {
        this.result_room.delete(room);
      }
    }
  }

  broadcast(data: ws.Data) {
    const result_client = Array.from(this.websocket_server.clients) || [];
    result_client.forEach(item_client => this.send(data, item_client));
  }

  send(data: ws.Data, socket: ws) {
    if (!socket || not_open(socket))
      return false;

    try {
      const payload = this.prepare_payload(data);

      socket.send(payload);

      this.emit('sent', payload);

      debug(`socket_id: ${this.result_socket.get(socket).lid} sending data`);
    } catch (error) {
      debug(`error '${error}'`);
      return false;
    }

    return true;
  }

  send_to_room(data: ws.Data, rooms_to_send_to: string | string[]) {
    if (!Array.isArray(rooms_to_send_to))
      rooms_to_send_to = [rooms_to_send_to];

    const result_room = Array.from(this.result_room.keys()).filter(r => rooms_to_send_to.indexOf(r) !== -1);

    result_room.forEach((item_room: string) => {
      const result_client = this.result_room.get(item_room) || [];

      result_client.forEach((item_client: ws) => {
        const info = this.result_socket.get(item_client);

        debug(`sending data to client ${info.lid}, room ${rooms_to_send_to}`);

        this.send(data, item_client);
      });
    });

    return true;
  }

  send_command(client: ws, command: string, value?: any) {
    const cmd = { '__command__': command };

    if (value) {
      cmd['__value__'] = value;
    }

    client.send(JSON.stringify(cmd));
  }

  public get clients(): Set<ws> {
    return this.websocket_server.clients;
  }

  public add_client(client: ws, data?: any) {
    this.websocket_server.clients.add(client);
    this.on_connection(client, data);
  }

  public get_client_info(client: ws): ISocketInfo {
    return this.result_socket.get(client);
  }

  public is_client_alive(client: ws): boolean {
    const info = this.result_socket.get(client);
    return info && info.alive;
  }

  public has_connection(address: string, port: number): boolean {
    const clients = Array.from(this.websocket_server.clients);

    for (let index = 0; index < clients.length; index++) {
      const info = this.get_client_info(clients[index]);
      const config = info.data && info.data.config || {};

      if (config.address === address && config.port === port) {
        return true;
      }
    }

    return false;
  }

  public set_client_data(client: ws, data: any): ISocketInfo {
    const info = this.result_socket.get(client);

    if (info) {
      Object.assign(info.data, data);
    }

    return info;
  }
}

export default my_server_websocket;
