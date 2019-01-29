import ws_node, { parseAddressString} from './ws_node'

// const KNOWN_NODES = [{
//     address: '127.0.0.1',
//     port: 20000
// }, {
//     address: '127.0.0.1',
//     port: 20001
// }];

const config = {
    address: process.env.ADDRESS,
    port: parseInt(process.env.PORT)
};

const node = new ws_node(config);
node.start_server(() => {
    if (process.env.NODES) {
        const configs = parseAddressString(process.env.NODES)

        configs.forEach(cfg => {
            node.connect(cfg.address, cfg.port);
        });
    }
});

/* TODO:

    Attach to first available port starting from 20000, address predefined
    Start ping on list of available nodes (now empty)
    Iterate over known nodes address and get list of nodes online from all
    Notify all nodes online about self
*/

