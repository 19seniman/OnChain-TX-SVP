require('dotenv').config();
const { ethers } = require('ethers');
const readline = require('readline/promises');

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

// Contract Addresses
const ROUTER_ADDRESS = "0xfe7bf2dfd5cb268c6779f1f614638a436cb701e4";
const WSVP_ADDRESS = "0x5300000000000000000000000000000000000004"; // WSVP Native
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
"function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
"function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)"
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

// ==========================================
// 3. FUNGSI UTILITAS & ANTI-SYBIL
// ==========================================
async function randomDelay(minSeconds, maxSeconds) {
const delay = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
console.log(⏳ [Anti-Sybil] Menunggu ${delay} detik...);
return new Promise(resolve => setTimeout(resolve, delay * 1000));
}

async function approveTokenIfNeeded(tokenAddress) {
const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
const balance = await tokenContract.balanceOf(wallet.address);
if (balance === 0n) return 0n; // Tidak ada yang perlu di-approve jika saldo 0

const allowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
if (allowance < balance) {
    console.log(`🔓 Mengizinkan Router untuk menggunakan token...`);
    const tx = await tokenContract.approve(ROUTER_ADDRESS, ethers.MaxUint256);
    await tx.wait();
    console.log(`✅ Token berhasil di-approve!`);
}
return balance;


}

// ==========================================
// 4. FUNGSI SWAP UTAMA
// ==========================================
async function swapSvpToToken(tokenAddress, tokenName) {
try {
const randomAmount = (Math.random() * (0.005 - 0.001) + 0.001).toFixed(4);
console.log(🔄 [1/2] Swap ${randomAmount} SVP ke ${tokenName}...);

    const amountIn = ethers.parseEther(randomAmount.toString());
    const path = [WSVP_ADDRESS, tokenAddress];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 10;

    const tx = await routerContract.swapExactETHForTokens(0, path, wallet.address, deadline, { value: amountIn });
    await tx.wait();
    console.log(`✅ Berhasil Swap SVP -> ${tokenName} (Hash: ${tx.hash})`);
    return true;
} catch (error) {
    console.error(`❌ Gagal Swap SVP ke ${tokenName}:`, error.reason || error.message);
    return false;
}


}

async function swapTokenToSvp(tokenAddress, tokenName) {
try {
console.log(🔄 [2/2] Mengembalikan ${tokenName} kembali ke SVP...);
const balance = await approveTokenIfNeeded(tokenAddress);

    if (balance === 0n) {
        console.log(`⚠️ Saldo ${tokenName} kosong, lewati swap back.`);
        return false;
    }

    const path = [tokenAddress, WSVP_ADDRESS];
    const deadline = Math.floor(Date.now() / 1000) + 60 * 10;

    const tx = await routerContract.swapExactTokensForETH(balance, 0, path, wallet.address, deadline);
    await tx.wait();
    console.log(`✅ Berhasil Swap ${tokenName} -> SVP (Hash: ${tx.hash})`);
    return true;
} catch (error) {
    console.error(`❌ Gagal Swap ${tokenName} ke SVP:`, error.reason || error.message);
    return false;
}


}

async function handleWsvp() {
try {
const randomAmount = (Math.random() * (0.005 - 0.001) + 0.001).toFixed(4);
const amountIn = ethers.parseEther(randomAmount.toString());

    console.log(`🔄 Wrapping ${randomAmount} SVP ke WSVP...`);
    const depositTx = await wsvpContract.deposit({ value: amountIn });
    await depositTx.wait();
    
    await randomDelay(10, 20);

    console.log(`🔄 Unwrapping WSVP kembali ke SVP...`);
    const withdrawTx = await wsvpContract.withdraw(amountIn);
    await withdrawTx.wait();
    console.log(`✅ Berhasil Wrap/Unwrap SVP!`);
} catch (error) {
    console.error(`❌ Gagal Wrap/Unwrap WSVP:`, error.reason || error.message);
}


}

// ==========================================
// 5. SIKLUS EKSEKUSI HARIAN
// ==========================================
async function runDailyCycle(loopCount) {
console.log(\n🚀 [MEMULAI SIKLUS HARIAN] Mengeksekusi ${loopCount} Putaran...\n);

for (let i = 1; i <= loopCount; i++) {
    console.log(`======================================`);
    console.log(`[Putaran ke-${i} dari ${loopCount}]`);

    // Rute 1: WSVP / SVP (Native Wrap/Unwrap)
    await handleWsvp();
    await randomDelay(15, 30);

    // Rute 2: Iterasi ke seluruh token (SVP -> Token -> SVP)
    const tokenKeys = Object.keys(TOKENS);
    for (const key of tokenKeys) {
        const tokenAddr = TOKENS[key];
        
        // Beli Token
        await swapSvpToToken(tokenAddr, key);
        await randomDelay(15, 40); // Jeda sebelum jual
        
        // Jual kembali ke SVP
        await swapTokenToSvp(tokenAddr, key);
        
        // Jeda antar rute koin
        await randomDelay(20, 45); 
    }
    console.log(`✅ Putaran ${i} Selesai.\n`);
}

console.log(`🎉 Seluruh putaran hari ini selesai! Script akan tertidur...`);
console.log(`💤 Menunggu 24 jam untuk siklus berikutnya... (JANGAN TUTUP TERMINAL INI)`);


}

async function main() {
try {
const answer = await rl.question('Berapa kali putaran rute transaksi ini dilakukan (per harinya)? : ');
const loopCount = parseInt(answer);

    if (isNaN(loopCount) || loopCount <= 0) {
        console.log("❌ Masukkan angka yang valid!");
        process.exit(1);
    }
    
    // Jalankan siklus pertama kali secara langsung
    await runDailyCycle(loopCount);

    // Set interval untuk mengulang fungsi setiap 24 jam (24 * 60 * 60 * 1000 milidetik)
    const SATU_HARI_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
        console.log(`\n⏰ Waktu 24 jam telah berlalu! Memulai siklus baru...`);
        await runDailyCycle(loopCount);
    }, SATU_HARI_MS);

} catch (err) {
    console.error("❌ Terjadi error sistem:", err);
}


}

// Jalankan Program
main();
