require('dotenv').config();
const { ethers } = require('ethers');
const readline = require('readline/promises');

// ==========================================
// 0. PENGATURAN TAMPILAN & WARNA (UI)
// ==========================================
const C = {
    reset: "\x1b[0m",
    bright: "\x1b[1m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
    magenta: "\x1b[35m",
    cyan: "\x1b[36m"
};

function getTime() {
    const now = new Date();
    return `${C.magenta}[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]${C.reset}`;
}

function showBanner() {
    console.clear();
    console.log(C.cyan + C.bright + "╔══════════════════════════════════════════════════════════╗");
    console.log("║                                                          ║");
    console.log("║               🚀 SVP TESTNET AUTO-SWAP 🚀                ║");
    console.log("║               (Anti-Sybil & Auto 24 Hours)               ║");
    console.log("║                                                          ║");
    console.log("╚══════════════════════════════════════════════════════════╝" + C.reset + "\n");
}

// ==========================================
// 1. SETUP & KONFIGURASI
// ==========================================
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const RPC_URL = process.env.RPC_URL || "https://rpc.svpchain.org";
const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const ROUTER_ADDRESS = "0xfe7bf2dfd5cb268c6779f1f614638a436cb701e4";
const WSVP_ADDRESS = "0x5300000000000000000000000000000000000004"; 
const TOKENS = {
    USDV: "0x013a61E622e6ABFCaB64F52D274C3Fc0aA37f951",
    WETH: "0x1c12dbda863900c680a3836c53d408feaf63f0ba",
    USDC: "0x771a0a63D8198b7dbea4a16910ff68AB38006531",
    WBTC: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162",
    WBNB: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df"
};

// ==========================================
// 2. ABIs
// ==========================================
const ROUTER_ABI = [
    "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable",
    "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external",
    "function getAmountsOut(uint amountIn, address[] calldata path) external view returns (uint[] memory amounts)",
    "function WETH() external view returns (address)"
];

const ERC20_ABI = [
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function balanceOf(address account) external view returns (uint256)"
];

const WSVP_ABI = [
    "function deposit() public payable",
    "function withdraw(uint wad) public"
];

const routerContract = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, wallet);
const wsvpContract = new ethers.Contract(WSVP_ADDRESS, WSVP_ABI, wallet);

let ROUTER_WETH_ADDRESS = WSVP_ADDRESS; 

// ==========================================
// 3. FUNGSI UTILITAS & ANTI-SYBIL
// ==========================================
async function randomDelay(minSeconds, maxSeconds) {
    const delay = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
    console.log(`${getTime()} ${C.yellow}⏳ [Anti-Sybil] Menunggu ${delay} detik...${C.reset}`);
    return new Promise(resolve => setTimeout(resolve, delay * 1000));
}

async function approveTokenIfNeeded(tokenAddress) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance === 0n) return 0n; 

    const allowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (allowance < balance) {
        console.log(`${getTime()} ${C.yellow}🔓 Mengizinkan Router menggunakan token...${C.reset}`);
        const tx = await tokenContract.approve(ROUTER_ADDRESS, ethers.MaxUint256, { gasLimit: 200000 });
        await tx.wait();
        console.log(`${getTime()} ${C.green}✅ Token berhasil di-approve!${C.reset}`);
    }
    return balance;
}

// ==========================================
// 4. FUNGSI SWAP UTAMA
// ==========================================
async function swapSvpToToken(tokenAddress, tokenName) {
    try {
        const randomAmount = (Math.random() * (0.03 - 0.01) + 0.01).toFixed(4);
        console.log(`${getTime()} ${C.blue}🔄 [1/2] Swap ${randomAmount} SVP -> ${tokenName}...${C.reset}`);

        const amountIn = ethers.parseEther(randomAmount.toString());
        const path = [ROUTER_WETH_ADDRESS, tokenAddress];

        // Mencegah Swap ke diri sendiri
        if (ROUTER_WETH_ADDRESS.toLowerCase() === tokenAddress.toLowerCase()) {
            console.log(`${getTime()} ${C.yellow}⚠️ Melewati ${tokenName} karena token tujuan sama dengan Base Token Router.${C.reset}`);
            return false;
        }

        // PRE-FLIGHT CHECK: Cek apakah pool ada & likuiditas tersedia
        try {
            const amounts = await routerContract.getAmountsOut(amountIn, path);
            if (amounts[1] === 0n) {
                console.log(`${getTime()} ${C.yellow}⚠️ Likuiditas ${tokenName} di DEX kosong. Swap dilewati agar tidak error.${C.reset}`);
                return false;
            }
        } catch (e) {
            console.log(`${getTime()} ${C.yellow}⚠️ Pool (Pair) untuk ${tokenName} tidak valid/belum dibuat. Swap dilewati.${C.reset}`);
            return false;
        }

        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
        
        // Menggunakan versi SupportingFeeOnTransferTokens agar anti error jika token memiliki pajak
        const tx = await routerContract.swapExactETHForTokensSupportingFeeOnTransferTokens(
            0, path, wallet.address, deadline, { 
            value: amountIn, 
            gasLimit: 1500000 
        });
        await tx.wait();
        console.log(`${getTime()} ${C.green}✅ Sukses (Hash: ${tx.hash})${C.reset}`);
        return true;
    } catch (error) {
        console.error(`${getTime()} ${C.red}❌ Gagal Swap SVP -> ${tokenName}: ${error.reason || error.message}${C.reset}`);
        return false;
    }
}

async function swapTokenToSvp(tokenAddress, tokenName) {
    try {
        console.log(`${getTime()} ${C.blue}🔄 [2/2] Swap All ${tokenName} -> SVP...${C.reset}`);
        const balance = await approveTokenIfNeeded(tokenAddress);

        if (balance === 0n) { 
            console.log(`${getTime()} ${C.yellow}⚠️ Saldo ${tokenName} kosong, lewati swap back.${C.reset}`);
            return false;
        }

        const path = [tokenAddress, ROUTER_WETH_ADDRESS];
        
        // PRE-FLIGHT CHECK
        try {
            const amounts = await routerContract.getAmountsOut(balance, path);
            if (amounts[1] === 0n) {
                console.log(`${getTime()} ${C.yellow}⚠️ Likuiditas balikan dari ${tokenName} ke SVP kosong. Swap dilewati.${C.reset}`);
                return false;
            }
        } catch (e) {
            console.log(`${getTime()} ${C.yellow}⚠️ Pool tidak dapat memproses kalkulasi swap back. Swap dilewati.${C.reset}`);
            return false;
        }

        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;

        const tx = await routerContract.swapExactTokensForETHSupportingFeeOnTransferTokens(
            balance, 0, path, wallet.address, deadline, {
            gasLimit: 1500000
        });
        await tx.wait();
        console.log(`${getTime()} ${C.green}✅ Sukses (Hash: ${tx.hash})${C.reset}`);
        return true;
    } catch (error) {
        console.error(`${getTime()} ${C.red}❌ Gagal Swap ${tokenName} -> SVP: ${error.reason || error.message}${C.reset}`);
        return false;
    }
}

async function handleWsvp() {
    try {
        const randomAmount = (Math.random() * (0.03 - 0.01) + 0.01).toFixed(4);
        const amountIn = ethers.parseEther(randomAmount.toString());

        console.log(`${getTime()} ${C.blue}🔄 Wrap ${randomAmount} SVP -> WSVP...${C.reset}`);
        const depositTx = await wsvpContract.deposit({ value: amountIn, gasLimit: 100000 });
        await depositTx.wait();
        
        await randomDelay(10, 20);

        console.log(`${getTime()} ${C.blue}🔄 Unwrap All WSVP -> SVP...${C.reset}`);
        const withdrawTx = await wsvpContract.withdraw(amountIn, { gasLimit: 100000 });
        await withdrawTx.wait();
        console.log(`${getTime()} ${C.green}✅ Sukses Wrap/Unwrap SVP!${C.reset}`);
    } catch (error) {
        console.error(`${getTime()} ${C.red}❌ Gagal Wrap/Unwrap WSVP: ${error.reason || error.message}${C.reset}`);
    }
}

// ==========================================
// 5. SIKLUS EKSEKUSI HARIAN
// ==========================================
async function runDailyCycle(loopCount) {
    console.log(`\n${C.bright}${C.cyan}▶ MEMULAI SIKLUS EKSEKUSI (${loopCount} PUTARAN) ◀${C.reset}\n`);

    for (let i = 1; i <= loopCount; i++) {
        console.log(`${C.bright}${C.yellow}====================================================${C.reset}`);
        console.log(`${C.bright}${C.yellow} 🚀 PUTARAN KE-${i} DARI ${loopCount} ${C.reset}`);
        console.log(`${C.bright}${C.yellow}====================================================${C.reset}\n`);

        await handleWsvp();
        await randomDelay(10, 20);

        const tokenKeys = Object.keys(TOKENS);
        for (const key of tokenKeys) {
            const tokenAddr = TOKENS[key];
            console.log(`\n${C.cyan}--- [ Rute: ${key} ] ---${C.reset}`);
            
            await swapSvpToToken(tokenAddr, key);
            await randomDelay(15, 30); 
            
            await swapTokenToSvp(tokenAddr, key);
            await randomDelay(15, 30); 
        }
        console.log(`\n${getTime()} ${C.green}${C.bright}✅ PUTARAN ${i} SELESAI!${C.reset}\n`);
    }

    console.log(`${C.bright}${C.green}🎉 SELURUH PUTARAN HARI INI SELESAI!${C.reset}`);
    console.log(`${getTime()} ${C.yellow}💤 Bot memasuki mode tidur (Sleep). Menunggu 24 Jam untuk siklus esok hari...${C.reset}`);
    console.log(`${C.red}⚠️  JANGAN TUTUP TERMINAL INI AGAR SCRIPT TETAP BERJALAN ⚠️${C.reset}`);
}

async function main() {
    try {
        showBanner();
        
        try {
            ROUTER_WETH_ADDRESS = await routerContract.WETH();
            console.log(`${getTime()} ${C.green}🔗 Terhubung ke Jaringan. Base Route: ${ROUTER_WETH_ADDRESS}${C.reset}\n`);
        } catch (e) {
            console.log(`${getTime()} ${C.yellow}⚠️ Gagal mendeteksi Base WETH dari router, menggunakan WSVP default.${C.reset}\n`);
        }

        const answer = await rl.question(`${C.bright}${C.cyan}[?] Berapa kali putaran rute transaksi per harinya? : ${C.reset}`);
        const loopCount = parseInt(answer);

        if (isNaN(loopCount) || loopCount <= 0) {
            console.log(`${C.red}❌ Masukkan angka yang valid!${C.reset}`);
            process.exit(1);
        }
        
        await runDailyCycle(loopCount);

        const SATU_HARI_MS = 24 * 60 * 60 * 1000;
        setInterval(async () => {
            showBanner();
            console.log(`${getTime()} ${C.green}⏰ Waktu 24 jam telah berlalu! Memulai siklus harian baru...${C.reset}`);
            await runDailyCycle(loopCount);
        }, SATU_HARI_MS);

    } catch (err) {
        console.error(`${C.red}❌ Terjadi error sistem: ${err}${C.reset}`);
    }
}

// Jalankan Program
main();
