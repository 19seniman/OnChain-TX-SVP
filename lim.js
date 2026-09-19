require('dotenv').config();
const { ethers } = require('ethers');

const C = {
    reset: "\x1b[0m", bright: "\x1b[1m", green: "\x1b[32m",
    red: "\x1b[31m", yellow: "\x1b[33m", cyan: "\x1b[36m"
};

const RPC_URL = process.env.RPC_URL || "https://rpc.svpchain.org";
const provider = new ethers.JsonRpcProvider(RPC_URL);

const ROUTER_ADDRESS = "0xfe7bf2dfd5cb268c6779f1f614638a436cb701e4";
const TOKENS = {
    USDV: "0x013a61E622e6ABFCaB64F52D274C3Fc0aA37f951",
    WETH: "0x1c12dbda863900c680a3836c53d408feaf63f0ba",
    USDC: "0x732f6ea7afd5edc02e7ba052075dd0780e285489",
    WBTC: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162",
    WBNB: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df"
};

const ROUTER_ABI = [
    "function WETH() external view returns (address)",
    "function factory() external view returns (address)",
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)"
];
const FACTORY_ABI = [
    "function getPair(address tokenA, address tokenB) external view returns (address pair)"
];
const PAIR_ABI = [
    "function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)"
];
const ERC20_ABI = [
    "function balanceOf(address account) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)"
];

async function main() {
    console.log(`${C.cyan}${C.bright}=== DIAGNOSTIK POOL / PAIR ===${C.reset}\n`);

    const network = await provider.getNetwork();
    console.log(`Chain ID: ${network.chainId}`);
    console.log(`RPC: ${RPC_URL}\n`);

    const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, provider);

    let wethAddress, factoryAddress;
    try {
        wethAddress = await router.WETH();
        console.log(`${C.green}Router.WETH():${C.reset} ${wethAddress}`);
    } catch (e) {
        console.log(`${C.red}❌ Gagal panggil router.WETH(): ${e.message}${C.reset}`);
        return;
    }

    try {
        factoryAddress = await router.factory();
        console.log(`${C.green}Router.factory():${C.reset} ${factoryAddress}\n`);
    } catch (e) {
        console.log(`${C.red}❌ Gagal panggil router.factory(): ${e.message}${C.reset}`);
        console.log(`${C.yellow}Kemungkinan besar ini BUKAN router UniswapV2 standar (tidak punya fungsi factory()). Ini bisa jadi penyebab utama semua swap gagal.${C.reset}`);
        return;
    }

    const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);

    for (const [name, tokenAddr] of Object.entries(TOKENS)) {
        console.log(`${C.bright}--- ${name} (${tokenAddr}) ---${C.reset}`);

        if (tokenAddr.toLowerCase() === wethAddress.toLowerCase()) {
            console.log(`${C.yellow}Ini adalah base token (WETH/wrapped native), dilewati.${C.reset}\n`);
            continue;
        }

        let pairAddress;
        try {
            pairAddress = await factory.getPair(wethAddress, tokenAddr);
        } catch (e) {
            console.log(`${C.red}❌ Gagal panggil factory.getPair(): ${e.message}${C.reset}\n`);
            continue;
        }

        if (pairAddress === ethers.ZeroAddress) {
            console.log(`${C.red}❌ TIDAK ADA PAIR untuk WETH-${name} di factory ini sama sekali.${C.reset}\n`);
            continue;
        }
        console.log(`Pair address: ${pairAddress}`);

        const pairCode = await provider.getCode(pairAddress);
        if (pairCode === "0x" || pairCode === "0x0") {
            console.log(`${C.red}❌ Pair terdaftar di factory tapi TIDAK ADA KODE KONTRAK di alamat itu (aneh / rusak).${C.reset}\n`);
            continue;
        }

        const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
        let reserve0, reserve1, token0, token1;
        try {
            [reserve0, reserve1] = await pair.getReserves();
            token0 = await pair.token0();
            token1 = await pair.token1();
        } catch (e) {
            console.log(`${C.red}❌ Gagal baca reserves/token0/token1: ${e.message}${C.reset}\n`);
            continue;
        }

        const wethToken = new ethers.Contract(wethAddress, ERC20_ABI, provider);
        const otherToken = new ethers.Contract(tokenAddr, ERC20_ABI, provider);

        let realWethBalance, realOtherBalance, otherSymbol = name, otherDecimals = 18;
        try {
            realWethBalance = await wethToken.balanceOf(pairAddress);
            realOtherBalance = await otherToken.balanceOf(pairAddress);
            otherDecimals = await otherToken.decimals();
            otherSymbol = await otherToken.symbol();
        } catch (e) {
            console.log(`${C.yellow}⚠️ Gagal baca balanceOf/decimals/symbol langsung dari token: ${e.message}${C.reset}`);
        }

        console.log(`token0: ${token0}`);
        console.log(`token1: ${token1}`);
        console.log(`Reserve tercatat di pair -> reserve0: ${reserve0.toString()}, reserve1: ${reserve1.toString()}`);
        if (realWethBalance !== undefined) {
            console.log(`Saldo WETH ASLI di alamat pair : ${ethers.formatEther(realWethBalance)}`);
            console.log(`Saldo ${otherSymbol} ASLI di alamat pair : ${ethers.formatUnits(realOtherBalance, otherDecimals)}`);

            const reserveMatchesWeth = (reserve0.toString() === realWethBalance.toString()) || (reserve1.toString() === realWethBalance.toString());
            if (!reserveMatchesWeth && (reserve0 > 0n || reserve1 > 0n)) {
                console.log(`${C.red}⚠️  MISMATCH: reserve yang tercatat TIDAK COCOK dengan saldo token asli di pair. Pool ini kemungkinan besar RUSAK / sudah didrain di luar jalur normal router.${C.reset}`);
            } else if (realWethBalance === 0n && realOtherBalance === 0n) {
                console.log(`${C.red}⚠️  Pool KOSONG (saldo kedua token = 0). Ini pasti akan revert saat swap.${C.reset}`);
            } else {
                console.log(`${C.green}✅ Reserve dan saldo asli terlihat konsisten.${C.reset}`);
            }
        }

        // Coba simulasikan getAmountsOut kecil untuk lihat harga yang dihitung
        try {
            const testAmount = ethers.parseEther("0.01");
            const amounts = await router.getAmountsOut(testAmount, [wethAddress, tokenAddr]);
            console.log(`getAmountsOut(0.01 WETH -> ${otherSymbol}) = ${amounts[1].toString()}`);
        } catch (e) {
            console.log(`${C.yellow}getAmountsOut gagal: ${e.message}${C.reset}`);
        }

        console.log('');
    }
}

main().catch(err => {
    console.error(`${C.red}Error fatal: ${err.message}${C.reset}`);
});
