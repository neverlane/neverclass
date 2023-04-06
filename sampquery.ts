import dns from 'dns';
import dgram, { Socket } from 'dgram';
import { BitStream } from './bitstream';
import iconv from 'iconv-lite';
 
export const resolveDns = (address: string) => 
  new Promise<string>((res, rej) => 
    dns.resolve(address, (e, addreses) => {
      if (e) return rej(e);
      res(addreses[0]);
    })
  );

export const decodeWin1251String = (str: Buffer) => iconv.decode(str, 'win1251');
export const bsReadCP1251String = (bs: BitStream, len: number) =>
  decodeWin1251String(bs.readBytes(len));

export interface SampQueryOptions {
  /**
   * Server IP address
   */
  ip?: string;
  /**
   * Server port
   */
  port?: number;
  /**
   * Request timeout
   */
  timeout?: number;
  /**
   * Resolve host
   */
  resolveHost?: boolean;
}

export type SampQueryOpcode = 'i' | 'r' | 'd' | 'c';

export interface SampQueryRequestOptions<O extends SampQueryOpcode = SampQueryOpcode> extends SampQueryOptions {
  /**
   * Opcode
   */
  opcode: O;
}

export type SampQueryServerRule = 'lagcomp' | 'mapname' | 'version' | 'weather' | 'weburl' | 'worldtime';
export interface SampQueryPlayer {
  id: number;
  ping: number;
  name: string;
  score: number;
}

export interface SampQueryInfoResult {
  serverName: string;
  gameModeName: string;
  players: number;
  maxPlayers: number;
  language: string;
  closed: boolean;
}

export type SampQueryRulesResult = Array<{ name: SampQueryServerRule, value: string }>;
export type SampQueryPlayersDetailedResult = Array<SampQueryPlayer>;
export type SampQueryPlayersResult = Array<Pick<SampQueryPlayer, 'name' | 'score'>>;

export class SampQuery {
  public socket?: Socket;
  public options: SampQueryOptions;

  constructor(options: SampQueryOptions) {
    this.options = options;
  }

  async getServer(options: SampQueryOptions = {}) {
    return {
      info: await this.request({
        ...options,
        opcode: 'i'
      }),
      rules: await this.request({
        ...options,
        opcode: 'r'
      }),
      players: await this.request({
        ...options,
        opcode: 'd'
      })
    };
  }

  async getServerInfo(options: SampQueryOptions = {}) {
    return this.request({
      ...options,
      opcode: 'i'
    });
  }

  async getServerRules(options: SampQueryOptions = {}) {
    return this.request({
      ...options,
      opcode: 'r'
    });
  }

  async getServerPlayers(options: SampQueryOptions = {}) {
    return this.request({
      ...options,
      opcode: 'c'
    });
  }

  async getServerPlayersDetailed(options: SampQueryOptions = {}) {
    return this.request({
      ...options,
      opcode: 'd'
    });
  }

  async getServerPing(options: SampQueryOptions = {}) {
    const startTime = Date.now();
    await this.request({
      ...options,
      opcode: 'i'
    });
    return (Date.now() - startTime);
  }

  async request(opts: SampQueryRequestOptions<'i'>): Promise<SampQueryInfoResult>
  async request(opts: SampQueryRequestOptions<'r'>): Promise<SampQueryRulesResult>
  async request(opts: SampQueryRequestOptions<'d'>): Promise<SampQueryPlayersDetailedResult>
  async request(opts: SampQueryRequestOptions<'c'>): Promise<SampQueryPlayersResult>
  async request({
    ip = this.options.ip,
    port = this.options.port,
    timeout = this.options.timeout,
    resolveHost = this.options.resolveHost,
    opcode
  }: SampQueryRequestOptions): Promise<any> {
    if (!ip) ip = '127.0.0.1';
    if (!port) port = 7777;
    if (!timeout) timeout = 2000;
    if (resolveHost === undefined) resolveHost = false;

    let resolve: (value: any) => void;
    let reject: (reason?: any) => void;

    const promise = new Promise<any>((r, rj) => {
      resolve = r, reject = rj;
    });

    if (resolveHost) ip = await resolveDns(ip);

    const socket = dgram.createSocket('udp4');

    const bs = new BitStream();
    bs.writeString('SAMP');
    for (const v of ip.split('.'))
      bs.writeUInt8(+v);
    bs.writeUInt8(port & 0xFF);
    bs.writeUInt8(port >> 8 & 0xFF);
    bs.writeUInt8(opcode.charCodeAt(0));

    socket.send(bs.getBuffer(), 0, bs.length, port, ip, (err) => {
      if (err) {
        reject(err);
        socket.close();
      }
    });

    let controller = setTimeout(() => {
      socket.close();
      reject(new Error(`[sampquery] [${ip}:${port}] host unavailable`));
    }, timeout);

    socket.once('message', async (message) => {
      try {
        clearTimeout(controller);
        if (message.length < 11) return reject(new Error(`[sampquery] [${this.options.ip}:${this.options.port}] invalid message from socket`));
        socket.close();
        let bytes = BitStream.from(message).slice(11);
        if (opcode === 'i') {
          const closed = bytes.readBoolean();
          const players = bytes.readUInt16()
          const maxPlayers = bytes.readUInt16()
          const serverName = bsReadCP1251String(bytes, bytes.readUInt32());
          const gameModeName = bsReadCP1251String(bytes, bytes.readUInt32());
          const language = bsReadCP1251String(bytes, bytes.readUInt32());
          return resolve({
            closed,
            players,
            maxPlayers,
            serverName,
            gameModeName,
            language
          });
        } else if (opcode === 'r') {
          const rulesResult: SampQueryRulesResult = [];
          const count = bytes.readUInt16()
          for (let i = 0; i < count; i++) {
            const name = <SampQueryServerRule> bsReadCP1251String(bytes, bytes.readUInt8());
            const value = bsReadCP1251String(bytes, bytes.readUInt8());
            rulesResult.push({
              name,
              value
            });
          }
          return resolve(rulesResult);
        } else if (opcode === 'd') {
          const playersResult: SampQueryPlayersDetailedResult = [];
          for (let i = 0; i < bytes.readUInt16(); i++) {
            const id = bytes.readUInt8();
            const name = bsReadCP1251String(bytes, bytes.readUInt8());
            const score = bytes.readUInt32();
            const ping = bytes.readUInt32();
            playersResult.push({
              id,
              name,
              score,
              ping,
            });
          }
          return resolve(playersResult);
        } else if (opcode === 'c') {
          const playersStatsResult: SampQueryPlayersResult = [];
          for (let i = 0; i < bytes.readUInt16(); i++) {
            const name = bsReadCP1251String(bytes, bytes.readUInt8());
            const score = bytes.readUInt32();
            playersStatsResult.push({
              name,
              score,
            });
          }
          return resolve(playersStatsResult);
        }
      } catch (error) {
        reject(error);
      }
    });
    return promise;
  }
}

// const sq = new SampQuery({
//   timeout: 25000
// })

// sq.getServerInfo({
//   ip: '185.169.134.60',
//   port: 8904
//   // ip: 'neverlane.xyz',
//   // port: 7777,
//   // resolveHost: true
// }).then(v => {
//   console.log(v)
// })