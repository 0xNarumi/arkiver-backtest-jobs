
import { type PublicClient, type Address } from "npm:viem";
import { Erc20Abi } from "../abis/erc20.ts";
import { FeedRegistryAbi } from "../abis/FeedRegistryAbi.ts";
import { EACAggregatorProxy } from "../abis/EACAggregatorProxy.ts"
import { velodromeAbi } from "../abis/velodromeAbi.ts";
import { VelodromeRouterAbi } from "../abis/VelodromeRouter.ts";
import { Univ3QuoterAbi } from "../abis/Univ3Quoter.ts";
import { UNIV2PairAbi } from "../abis/UNIV2PairAbi.ts";
import { IToken } from "../entities/token.ts";
import { toNumber } from "./util.ts";
import { Store } from "https://deno.land/x/robo_arkiver/mod.ts";
import { ethers } from "npm:ethers";

export const CLPriceRegistry = '0x47Fb2585D2C56Fe188D0E6ec628a38b74fCeeeDf'
const Univ3QuoterAddress = '0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6'
export const USD = "0x0000000000000000000000000000000000000348" // The ID for USD in the FeedRegistry
const USDC = "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8"
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1"
const CLMap = {	
	"arbitrum one": {
		"0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8": "0x50834F3163758fcC1Df9973b6e91f0F0F0434aD3", //USDC
		"0x82aF49447D8a07e3bd95BD0d56f35241523fBab1": "0x639fe6ab55c921f74e7fac1ee960c0b6293ba612", //WETH
	}
}

const UNIV2Map = {"0x5f98805A4E8be255a32880FDeC7F6728C6568bA0": "0xF20EF17b889b437C151eB5bA15A47bFc62bfF469"}

export class TokenPrice {
	static async get(client: PublicClient, store: Store, block: bigint, token: any): Promise<number> {
		return await store.retrieve(`TokenPrice:${token.address}:${Number(block)}`, async () => {
			try {
				return await TokenPrice.getCLPrice(client, block, token.address)
				
			} catch(e) {
				try{
					return await TokenPrice.getUniv3SpotPrice(client, store, block, token.address)
				} catch(e) {
					try{
						return await TokenPrice.getUniv2SpotPrice(client, store, block, token.address)
					} catch(e){
						// As you can see, this bad.
						return 0
					}
				}
			}
		})
	}

	static async getUniv3SpotPrice(client: PublicClient, store: Store, block: bigint, token: Address) {
		const { result } = await client.simulateContract({
			abi: Univ3QuoterAbi,
			address: Univ3QuoterAddress,
			functionName: "quoteExactInputSingle",
			args: [token, USDC, 500, ethers.parseUnits('1', 18), 0],
			blockNumber: block,
		})
		return toNumber(result as bigint, 6)
	}

	static async getUniv2SpotPrice(client: PublicClient, store: Store, block: bigint, token: Address) {
		if(!UNIV2Map[token]){
			console.log("failed to fetch V2 map")
			throw('failed to fetch V2 map')
		}
		console.log(`UNIV2Map[token]: ${UNIV2Map[token]}`)
		const { result } = await client.simulateContract({
			abi: UNIV2PairAbi,
			address: UNIV2Map[token],
			functionName: "getReserves",
			blockNumber: block,
		})
		const token0 = toNumber(result[0], 18) //TODO We need to get decimals from caller
		const token1 = toNumber(result[1], 18)
		const price = token1/token0
		const priceWeth = await store.retrieve(`${block}:${WETH}:CLprice`, async () => {
			return await TokenPrice.getCLPrice(client, block, WETH)
		})
		const priceToken = price*priceWeth
		return priceToken
		///return toNumber(result as bigint, 6)
	}


	static async getVelodromeSpotPrice(client: PublicClient, block: bigint, token: any) {
		const VELODROME_ROUTER = "0x9c12939390052919aF3155f41Bf4160Fd3666A6f"
		const swapAmount = 10 ** token.decimals
		const amountOut = await client.readContract({
			abi: VelodromeRouterAbi,
			address: VELODROME_ROUTER,
			functionName: "getAmountOut",
			args: [swapAmount, token.address, USDC ],
			blockNumber: block,
		})

		return toNumber(amountOut[0], 6)
	}

	static async getCLPrice(client: PublicClient, block: bigint, token: Address) {
		//console.log(`getCLPrice oracle: ${CLMap[client.chain.name.toLowerCase()][token]}`)
		//console.log(`getCLPrice token: ${token}`)
		const result = await client.readContract({
			abi: EACAggregatorProxy,
			address: CLMap[client.chain.name.toLowerCase()][token],
			functionName: "latestAnswer",
			blockNumber: block,
		})
		return toNumber(result as bigint, 8)
	}

	static async getPoolPrice(client: PublicClient, store: Store, block: bigint, pool: ICurvePool) {
		// Get total supply and reserves
		const [
			totalSupply,
			reservesBigInt
		] = await Promise.all([
			client.readContract({
				abi: Erc20Abi,
				address: info.token,
				functionName: "totalSupply",
				blockNumber: block.number!,
			}),
			client.readContract({
				abi: velodromeAbi,
				address: info.pool,
				functionName: "getReserves",
				blockNumber: block.number!,
			})
		])
		const reserves = reservesBigInt.map((e, i) => toNumber(e, pool.tokens[i].decimals))
		const prices = (await Promise.all(pool.tokens.map((token) => TokenPrice.get(client, store, block, token.address))))
		const lpValue = reserves.reduce((acc, reserve, i) => acc + (reserve * prices[i]!), 0)
		const price = lpValue / totalSupply
		return price
	}

	static async getAavePoolPrice(client: PublicClient, block: bigint, pool: IAavePool) {
		// AAVE tokens have a 1to1 with their underlying
		return await TokenPrice.getCLPrice(client, block, pool.underlying.address)
	}

}