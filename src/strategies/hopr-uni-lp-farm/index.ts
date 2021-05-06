import { formatUnits } from '@ethersproject/units';
import { BigNumber } from '@ethersproject/bignumber';
import { getScores, multicall, subgraphRequest } from '../../utils';
import { getBlockNumber } from '../../utils/web3';

export const author = 'hoprnet';
export const version = '0.1.0';

const tokenAndPoolAbi = [
  {
    constant:true,
    inputs:[
       {
          internalType:"address",
          name:"",
          type:"address"
       }
    ],
    name:"balanceOf",
    outputs:[
       {
          internalType:"uint256",
          name:"",
          type:"uint256"
       }
    ],
    payable:false,
    stateMutability:"view",
    type:"function"
  },
  {
    constant:true,
    inputs:[

    ],
    name:"totalSupply",
    outputs:[
      {
          internalType:"uint256",
          name:"",
          type:"uint256"
      }
    ],
    payable:false,
    stateMutability:"view",
    type:"function"
  },
  {
    inputs:[
       {
          internalType:"address",
          name:"",
          type:"address"
       }
    ],
    name:"liquidityProviders",
    outputs:[
       {
          internalType:"uint256",
          name:"claimedUntil",
          type:"uint256"
       },
       {
          internalType:"uint256",
          name:"currentBalance",
          type:"uint256"
       }
    ],
    stateMutability:"view",
    type:"function"
 }
];

const XDAI_BLOCK_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/1hive/xdai-blocks';
const HOPR_XDAI_SUBGRAPH_URL = 'https://api.thegraph.com/subgraphs/name/hoprnet/hopr-on-xdai';

async function getXdaiBlockNumber (timestamp: number): Promise<number> {
  const query = {
    blocks: {
      __args: {
        first: 1,
        orderBy: 'number',
        orderDirection: 'desc',
        where: {
          timestamp_lte: timestamp
        }
      },
      number: true,
      timestamp: true
    }
  };
  const data = await subgraphRequest(XDAI_BLOCK_SUBGRAPH_URL, query);
  return Number(data.blocks[0].number);
}

async function xHoprSubgraphQuery (addresses: string[], blockNumber: number): Promise<{[propName: string]:number}> {
  const query = {
    accounts: {
      __args: {
        block: {
          number: blockNumber
        },
        where: {
          id_in: addresses.map(adr => adr.toLowerCase())
        }
      },
      id: true,
      totalBalance: true
    }
  }
  const data = await subgraphRequest(HOPR_XDAI_SUBGRAPH_URL, query);
  // map result (data.accounts) to addresses
  const entries = data.accounts.map(d => [d.id, Number(d.totalBalance)])
  return Object.fromEntries(entries);
}

export async function strategy(
  space,
  network,
  provider,
  addresses,
  options,
  snapshot
) {
  const blockTag = typeof snapshot === 'number' ? snapshot : 'latest';
  const res = await multicall(
    network,
    provider,
    tokenAndPoolAbi,
    [
      [options.hoprAddress, 'balanceOf', [options.uniPoolAddress]],
      [options.uniPoolAddress, 'totalSupply', []],
    ].concat(
      addresses.map(
        (address: any) => [options.uniPoolAddress, 'balanceOf', [address]]
      )
    ).concat(
      blockTag >= options.farmDeployBlock || blockTag === 'latest' ? addresses.map(
        (address: any) => [options.farmAddress, 'liquidityProviders', [address]]
      ) : []
    ),
    { blockTag }
  );

  const hoprBalanceOfPool = res[0];
  const poolTotalSupply = res[1];
  const response: BigNumber[] = blockTag >= options.farmDeployBlock || blockTag === 'latest'
    ? res.slice(2, 2 + addresses.length).map((r, i) => (r[0] as BigNumber).add(res[2 + i + addresses.length][1] as BigNumber))
    : res.slice(2).map(r => r[0] as BigNumber);

  // get block timestamp to search on xDai subgraph
  const snapshotTimestamp = (await provider.getBlock(blockTag)).timestamp;
  const snapshotXdaiBlock = await getXdaiBlockNumber(snapshotTimestamp);
  // get and parse xHOPR and wxHOPR balance
  const hoprOnXdaiBalance = await xHoprSubgraphQuery(addresses, snapshotXdaiBlock);
  const hoprOnXdaiScore = addresses.map(address => hoprOnXdaiBalance[address] ?? 0)

  // get HOPR token balance
  const hoprScore = await getScores(space, [{
      name: "erc20-balance-of",
      params: {
        address: options.hoprAddress,
        symbol: "HOPR",
        decimals: 18
      }
    }], "1", provider, addresses, snapshot);

  return Object.fromEntries(
    response.map((value, i) => [
      addresses[i], // LP token amount * pool's HOPR token balnce / total pool supply
      parseFloat(formatUnits(
        value.mul(hoprBalanceOfPool[0]).div(poolTotalSupply[0]
      ), 18))
      + hoprScore[0][addresses[i]] // HOPR token balance
      + hoprOnXdaiScore[i] // xHOPR + wxHOPR balance
    ])
  );
}