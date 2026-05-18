import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Escrow } from "../target/types/escrow";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAssociatedTokenAddressSync,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";

describe("escrow", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.Escrow as Program<Escrow>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;

  const maker = anchor.web3.Keypair.generate();
  const taker = anchor.web3.Keypair.generate();

  let mintA: anchor.web3.PublicKey;
  let mintB: anchor.web3.PublicKey;
  let makerAtaA: anchor.web3.PublicKey;
  let takerAtaB: anchor.web3.PublicKey;

  const seed = new anchor.BN(1);
  const depositAmount = 1_000_000;
  const receiveAmount = 500_000;

  const getEscrowPda = () => {
    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        maker.publicKey.toBuffer(),
        seed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    return escrowPda;
  };

  before(async () => {
    // Airdrop SOL to maker and taker
    const makerAirdrop = await connection.requestAirdrop(
      maker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(makerAirdrop);

    const takerAirdrop = await connection.requestAirdrop(
      taker.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(takerAirdrop);

    // Create Mint A (maker will deposit this)
    mintA = await createMint(
      connection,
      maker,
      maker.publicKey,
      null,
      6
    );

    // Create Mint B (taker will send this)
    mintB = await createMint(
      connection,
      taker,
      taker.publicKey,
      null,
      6
    );

    // Create maker's ATA for mint A and mint tokens
    makerAtaA = await createAssociatedTokenAccount(
      connection,
      maker,
      mintA,
      maker.publicKey
    );
    await mintTo(connection, maker, mintA, makerAtaA, maker, depositAmount * 2);

    // Create taker's ATA for mint B and mint tokens
    takerAtaB = await createAssociatedTokenAccount(
      connection,
      taker,
      mintB,
      taker.publicKey
    );
    await mintTo(connection, taker, mintB, takerAtaB, taker, receiveAmount * 2);
  });

  it("Make - creates an escrow and deposits tokens", async () => {
    const escrowPda = getEscrowPda();

    const vault = getAssociatedTokenAddressSync(
      mintA,
      escrowPda,
      true
    );

    const tx = await program.methods
      .make(seed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
      .accountsPartial({
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        makerAtaA: makerAtaA,
        escrow: escrowPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    console.log("Make tx:", tx);

    // Verify escrow state
    const escrowState = await program.account.escrow.fetch(escrowPda);
    expect(escrowState.maker.toBase58()).to.equal(maker.publicKey.toBase58());
    expect(escrowState.mintA.toBase58()).to.equal(mintA.toBase58());
    expect(escrowState.mintB.toBase58()).to.equal(mintB.toBase58());
    expect(escrowState.receive.toNumber()).to.equal(receiveAmount);
    expect(escrowState.seed.toNumber()).to.equal(1);

    // Verify vault received the tokens
    const vaultAccount = await getAccount(connection, vault);
    expect(Number(vaultAccount.amount)).to.equal(depositAmount);
  });

  it("Take - taker completes the escrow swap", async () => {
    const escrowPda = getEscrowPda();

    const vault = getAssociatedTokenAddressSync(
      mintA,
      escrowPda,
      true
    );

    const takerAtaA = getAssociatedTokenAddressSync(
      mintA,
      taker.publicKey
    );

    const makerAtaB = getAssociatedTokenAddressSync(
      mintB,
      maker.publicKey
    );

    const tx = await program.methods
      .take()
      .accountsPartial({
        taker: taker.publicKey,
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        takerAtaA: takerAtaA,
        takerAtaB: takerAtaB,
        makerAtaB: makerAtaB,
        escrow: escrowPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([taker])
      .rpc();

    console.log("Take tx:", tx);

    // Verify taker received token A
    const takerAtaAAccount = await getAccount(connection, takerAtaA);
    expect(Number(takerAtaAAccount.amount)).to.equal(depositAmount);

    // Verify maker received token B
    const makerAtaBAccount = await getAccount(connection, makerAtaB);
    expect(Number(makerAtaBAccount.amount)).to.equal(receiveAmount);

    // Verify escrow account is closed
    try {
      await program.account.escrow.fetch(escrowPda);
      expect.fail("Escrow should be closed");
    } catch (err) {
      expect(err.message).to.include("Account does not exist or has no data");
    }
  });

  it("Make + Refund - maker cancels the escrow", async () => {
    const refundSeed = new anchor.BN(2);

    const [escrowPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("escrow"),
        maker.publicKey.toBuffer(),
        refundSeed.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const vault = getAssociatedTokenAddressSync(
      mintA,
      escrowPda,
      true
    );

    // First make an escrow
    await program.methods
      .make(refundSeed, new anchor.BN(depositAmount), new anchor.BN(receiveAmount))
      .accountsPartial({
        maker: maker.publicKey,
        mintA: mintA,
        mintB: mintB,
        makerAtaA: makerAtaA,
        escrow: escrowPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    // Get maker's balance before refund
    const makerBalanceBefore = await getAccount(connection, makerAtaA);

    // Now refund
    const tx = await program.methods
      .refund()
      .accountsPartial({
        maker: maker.publicKey,
        mintA: mintA,
        makerAtaA: makerAtaA,
        escrow: escrowPda,
        vault: vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([maker])
      .rpc();

    console.log("Refund tx:", tx);

    // Verify maker got tokens back
    const makerBalanceAfter = await getAccount(connection, makerAtaA);
    expect(Number(makerBalanceAfter.amount)).to.equal(
      Number(makerBalanceBefore.amount) + depositAmount
    );

    // Verify escrow account is closed
    try {
      await program.account.escrow.fetch(escrowPda);
      expect.fail("Escrow should be closed");
    } catch (err) {
      expect(err.message).to.include("Account does not exist or has no data");
    }
  });
});
