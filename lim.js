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
    console.log("║           (Anti-Sybil, Auto-Slippage, 24 Hours)          ║");
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
const WSVP_ADDRESS = "0x771a0a63D8198b7dbea4a16910ff68AB38006531";
const TOKENS = {
    USDV: "0x013a61E622e6ABFCaB64F52D274C3Fc0aA37f951",
    WETH: "0x1c12dbda863900c680a3836c53d408feaf63f0ba",
    USDC: "0x732f6ea7afd5edc02e7ba052075dd0780e285489",
    WBTC: "0x6c22ceb0852bd7781b57574aaa5de0f22cd44162",
    WBNB: "0x8787384b8640f6e9c30e94585d3d62b03f80a5df"
};

// Bisa dikonfigurasi lewat .env: SLIPPAGE_PERCENT=10 artinya toleransi 10%
const SLIPPAGE_PERCENT = BigInt(process.env.SLIPPAGE_PERCENT || "10");
// Buffer gas tambahan di atas hasil estimateGas (dalam persen)
const GAS_BUFFER_PERCENT = 30n;
// Minimal saldo native yang harus tersisa untuk menutupi gas (dalam ETH/SVP)
const MIN_NATIVE_RESERVE = ethers.parseEther(process.env.MIN_NATIVE_RESERVE || "0.005");

// ==========================================
// 2. ABIs
// ==========================================
const ROUTER_ABI = [
    "function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) external payable returns (uint[] memory amounts)",
    "function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) external returns (uint[] memory amounts)",
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

// Default base routing token (akan ditimpa secara otomatis oleh router.WETH())
let ROUTER_WETH_ADDRESS = "0x1c12dbda863900c680a3836c53d408feaf63f0ba";
// wsvpContract dibuat ULANG setelah alamat wrapped-native asli terdeteksi dari router,
// karena WSVP_ADDRESS yang di-hardcode di atas TERBUKTI SALAH untuk chain ini
// (tidak ada kontrak di sana - lihat verifyContractsExist()).
let wsvpContract = new ethers.Contract(WSVP_ADDRESS, WSVP_ABI, wallet);

// ==========================================
// 3. FUNGSI UTILITAS & ANTI-SYBIL
// ==========================================
async function randomDelay(minSeconds, maxSeconds) {
    const delay = Math.floor(Math.random() * (maxSeconds - minSeconds + 1)) + minSeconds;
    console.log(`${getTime()} ${C.yellow}⏳ [Anti-Sybil] Menunggu ${delay} detik...${C.reset}`);
    return new Promise(resolve => setTimeout(resolve, delay * 1000));
}

// Ambil pesan revert yang lebih jelas dari sebuah error ethers v6
function extractRevertReason(error) {
    if (error?.reason) return error.reason;
    if (error?.shortMessage) return error.shortMessage;
    if (error?.info?.error?.message) return error.info.error.message;
    if (error?.data) {
        try {
            const decoded = ethers.toUtf8String('0x' + error.data.slice(138));
            if (decoded) return decoded;
        } catch (_) { /* abaikan, gagal decode manual */ }
    }
    return error?.message || 'Alasan tidak diketahui (revert tanpa pesan)';
}

const DEBUG = process.env.DEBUG === "1" || process.env.DEBUG === "true";

// Simulasikan transaksi dulu (staticCall) sebelum benar-benar mengirimnya.
// Ini penting supaya kalau bakal revert, kita tahu ALASANNYA dan tidak buang gas.
async function simulateAndEstimate(contract, method, args, overrides = {}) {
    try {
        await contract[method].staticCall(...args, overrides);
    } catch (error) {
        if (DEBUG) {
            console.log(`${C.red}--- RAW ERROR (DEBUG) ---${C.reset}`);
            console.log(JSON.stringify(error, Object.getOwnPropertyNames(error), 2));
            console.log(`${C.red}-------------------------${C.reset}`);
        }
        return { ok: false, reason: extractRevertReason(error) };
    }

    try {
        const estimated = await contract[method].estimateGas(...args, overrides);
        const gasLimit = (estimated * (100n + GAS_BUFFER_PERCENT)) / 100n;
        return { ok: true, gasLimit };
    } catch (error) {
        // Static call sukses tapi estimateGas gagal (jarang) -> tetap pakai gas limit default aman
        return { ok: true, gasLimit: 1500000n };
    }
}

async function approveTokenIfNeeded(tokenAddress) {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, wallet);
    const balance = await tokenContract.balanceOf(wallet.address);
    if (balance === 0n) return 0n;

    const allowance = await tokenContract.allowance(wallet.address, ROUTER_ADDRESS);
    if (allowance < balance) {
        console.log(`${getTime()} ${C.yellow}🔓 Mengizinkan Router menggunakan token...${C.reset}`);
        try {
            const tx = await tokenContract.approve(ROUTER_ADDRESS, ethers.MaxUint256, { gasLimit: 200000 });
            await tx.wait();
            console.log(`${getTime()} ${C.green}✅ Token berhasil di-approve!${C.reset}`);
            await randomDelay(3, 5);
        } catch (error) {
            console.error(`${getTime()} ${C.red}❌ Gagal approve token: ${extractRevertReason(error)}${C.reset}`);
            return 0n;
        }
    }
    return balance;
}

// ==========================================
// 4. FUNGSI SWAP UTAMA DENGAN SLIPPAGE
// ==========================================
async function swapSvpToToken(tokenAddress, tokenName) {
    try {
        const randomAmount = (Math.random() * (0.03 - 0.01) + 0.01).toFixed(4);
        console.log(`${getTime()} ${C.blue}🔄 [1/2] Swap ${randomAmount} SVP -> ${tokenName}...${C.reset}`);

        const amountIn = ethers.parseEther(randomAmount.toString());
        const path = [ROUTER_WETH_ADDRESS, tokenAddress];

        if (ROUTER_WETH_ADDRESS.toLowerCase() === tokenAddress.toLowerCase()) {
            console.log(`${getTime()} ${C.yellow}⚠️ Melewati karena ${tokenName} adalah Base Token Router.${C.reset}`);
            return false;
        }

        // Cek saldo native cukup (amountIn + cadangan gas)
        const nativeBalance = await provider.getBalance(wallet.address);
        if (nativeBalance < amountIn + MIN_NATIVE_RESERVE) {
            console.log(`${getTime()} ${C.yellow}⚠️ Saldo native tidak cukup untuk swap + gas. Melewati.${C.reset}`);
            return false;
        }

        // 1. Cek harga & likuiditas
        let amountOutMin = 0n;
        try {
            const amountsOut = await routerContract.getAmountsOut(amountIn, path);
            amountOutMin = (amountsOut[amountsOut.length - 1] * (100n - SLIPPAGE_PERCENT)) / 100n;
        } catch (e) {
            console.log(`${getTime()} ${C.yellow}⚠️ Pool likuiditas ${tokenName} tidak ditemukan. Melewati rute ini.${C.reset}`);
            return false;
        }

        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
        const args = [amountOutMin, path, wallet.address, deadline];
        const overrides = { value: amountIn };

        // 2. Simulasikan dulu supaya tahu alasan pasti kalau gagal
        const sim = await simulateAndEstimate(routerContract, 'swapExactETHForTokens', args, overrides);
        if (!sim.ok) {
            console.log(`${getTime()} ${C.yellow}⚠️ Simulasi gagal (${tokenName}): ${sim.reason}. Melewati tanpa kirim tx.${C.reset}`);
            return false;
        }

        // 3. Eksekusi swap dengan gas limit hasil estimasi + buffer
        const tx = await routerContract.swapExactETHForTokens(...args, { ...overrides, gasLimit: sim.gasLimit });
        await tx.wait();
        console.log(`${getTime()} ${C.green}✅ Sukses (Hash: ${tx.hash})${C.reset}`);
        return true;
    } catch (error) {
        console.error(`${getTime()} ${C.red}❌ Gagal Swap SVP -> ${tokenName}: ${extractRevertReason(error)}${C.reset}`);
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

        let amountOutMin = 0n;
        try {
            const amountsOut = await routerContract.getAmountsOut(balance, path);
            amountOutMin = (amountsOut[amountsOut.length - 1] * (100n - SLIPPAGE_PERCENT)) / 100n;
        } catch (e) {
            console.log(`${getTime()} ${C.yellow}⚠️ Harga balikan gagal dihitung. Melewati rute ini.${C.reset}`);
            return false;
        }

        const deadline = Math.floor(Date.now() / 1000) + 60 * 10;
        const args = [balance, amountOutMin, path, wallet.address, deadline];

        const sim = await simulateAndEstimate(routerContract, 'swapExactTokensForETH', args);
        if (!sim.ok) {
            console.log(`${getTime()} ${C.yellow}⚠️ Simulasi gagal (${tokenName} -> SVP): ${sim.reason}. Melewati tanpa kirim tx.${C.reset}`);
            return false;
        }

        const tx = await routerContract.swapExactTokensForETH(...args, { gasLimit: sim.gasLimit });
        await tx.wait();
        console.log(`${getTime()} ${C.green}✅ Sukses (Hash: ${tx.hash})${C.reset}`);
        return true;
    } catch (error) {
        console.error(`${getTime()} ${C.red}❌ Gagal Swap ${tokenName} -> SVP: ${extractRevertReason(error)}${C.reset}`);
        return false;
    }
}

async function handleWsvp() {
    if (!wsvpContract) {
        console.log(`${getTime()} ${C.yellow}⚠️ Kontrak WSVP tidak tersedia, melewati wrap/unwrap.${C.reset}`);
        return;
    }
    try {
        const randomAmount = (Math.random() * (0.03 - 0.01) + 0.01).toFixed(4);
        const amountIn = ethers.parseEther(randomAmount.toString());

        const nativeBalance = await provider.getBalance(wallet.address);
        if (nativeBalance < amountIn + MIN_NATIVE_RESERVE) {
            console.log(`${getTime()} ${C.yellow}⚠️ Saldo native tidak cukup untuk wrap/unwrap. Melewati.${C.reset}`);
            return;
        }

        console.log(`${getTime()} ${C.blue}🔄 Wrap ${randomAmount} SVP -> WSVP...${C.reset}`);
        const depositTx = await wsvpContract.deposit({ value: amountIn, gasLimit: 200000 });
        await depositTx.wait();

        await randomDelay(10, 20);

        console.log(`${getTime()} ${C.blue}🔄 Unwrap All WSVP -> SVP...${C.reset}`);
        const withdrawTx = await wsvpContract.withdraw(amountIn, { gasLimit: 200000 });
        await withdrawTx.wait();
        console.log(`${getTime()} ${C.green}✅ Sukses Wrap/Unwrap SVP!${C.reset}`);
    } catch (error) {
        console.error(`${getTime()} ${C.red}❌ Gagal Wrap/Unwrap WSVP: ${extractRevertReason(error)}${C.reset}`);
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

// Pastikan alamat-alamat penting benar-benar berisi kontrak (bukan salah alamat / EOA / jaringan salah)
async function verifyContractsExist() {
    const addressesToCheck = {
        ROUTER: ROUTER_ADDRESS,
        ...TOKENS
    };

    let allOk = true;
    for (const [name, addr] of Object.entries(addressesToCheck)) {
        const code = await provider.getCode(addr);
        if (code === "0x" || code === "0x0") {
            console.log(`${getTime()} ${C.red}❌ Tidak ada kontrak di alamat ${name} (${addr}). Cek RPC_URL / alamat ini benar untuk network yang sedang dipakai.${C.reset}`);
            allOk = false;
        }
    }
    if (allOk) {
        console.log(`${getTime()} ${C.green}✅ Semua alamat kontrak terverifikasi ada di chain ini.${C.reset}`);
    }
    return allOk;
}

async function main() {
    try {
        showBanner();

        const network = await provider.getNetwork();
        console.log(`${getTime()} ${C.cyan}🌐 Terhubung ke chainId: ${network.chainId}${C.reset}`);

        const contractsOk = await verifyContractsExist();
        if (!contractsOk) {
            console.log(`${getTime()} ${C.yellow}⚠️ Lanjut tetap dijalankan, tapi kemungkinan besar akan ada error "missing revert data" pada alamat yang bermasalah di atas.${C.reset}\n`);
        }

        try {
            ROUTER_WETH_ADDRESS = await routerContract.WETH();
            console.log(`${getTime()} ${C.green}🔗 Terhubung. Base Route Terdeteksi: ${ROUTER_WETH_ADDRESS}${C.reset}\n`);
        } catch (e) {
            console.log(`${getTime()} ${C.yellow}⚠️ Gagal cek Router WETH, menggunakan default manual.${C.reset}\n`);
        }

        // Tentukan kontrak wrap/unwrap: prioritaskan WSVP_ADDRESS yang sudah ditentukan manual.
        // Kalau alamat itu ternyata tidak berisi kontrak, baru fallback ke alamat wrapped-native
        // hasil deteksi otomatis dari router.WETH().
        const wsvpManualCode = await provider.getCode(WSVP_ADDRESS);
        if (wsvpManualCode !== "0x" && wsvpManualCode !== "0x0") {
            wsvpContract = new ethers.Contract(WSVP_ADDRESS, WSVP_ABI, wallet);
            console.log(`${getTime()} ${C.green}🔧 Kontrak wrap/unwrap memakai alamat manual: ${WSVP_ADDRESS}${C.reset}\n`);
        } else {
            console.log(`${getTime()} ${C.yellow}⚠️ Alamat WSVP manual (${WSVP_ADDRESS}) tidak berisi kontrak.${C.reset}`);
            const routerWethCode = await provider.getCode(ROUTER_WETH_ADDRESS);
            if (routerWethCode !== "0x" && routerWethCode !== "0x0") {
                wsvpContract = new ethers.Contract(ROUTER_WETH_ADDRESS, WSVP_ABI, wallet);
                console.log(`${getTime()} ${C.green}🔧 Fallback: kontrak wrap/unwrap memakai alamat terdeteksi router: ${ROUTER_WETH_ADDRESS}${C.reset}\n`);
            } else {
                console.log(`${getTime()} ${C.red}❌ Kedua alamat WSVP tidak valid. Fitur wrap/unwrap (handleWsvp) akan dilewati.${C.reset}\n`);
                wsvpContract = null;
            }
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
