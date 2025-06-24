// Copyright (c) Mysten Labs, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  useCurrentAccount,
  useSignAndExecuteTransaction,
} from "@mysten/dapp-kit";
import { getFullnodeUrl, SuiClient } from "@mysten/sui/client";
import { getFaucetHost, requestSuiFromFaucetV2 } from "@mysten/sui/faucet";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { MIST_PER_SUI, parseStructTag } from "@mysten/sui/utils";

import { TESTNET_WALRUS_PACKAGE_CONFIG, WalrusClient } from "@mysten/walrus";
import { useState } from "react";

const suiClient = new SuiClient({
  url: getFullnodeUrl("testnet"),
});

const walrusClient = new WalrusClient({
  network: "testnet",
  suiClient,
  storageNodeClientOptions: {
    timeout: 60_000,
  },
});

export function FileUpload() {
  const { mutateAsync: signAndExecuteTransaction } =
    useSignAndExecuteTransaction();
  const currentAccount = useCurrentAccount();
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");

  if (!currentAccount) {
    return <div>No account connected</div>;
  }

  return (
    <>
      <button onClick={() => uploadFile().catch((e) => setError(e.message))}>
        Upload File
      </button>
      <p>{status}</p>
    </>
  );

  async function uploadFile() {
    setStatus("Getting WAL...");
    await getWal();

    setStatus("Encoding file...");
    const file = new TextEncoder().encode("Hello from the TS SDK!!!\n");

    const encoded = await walrusClient.encodeBlob(file);

    setStatus("Registering blob...");

    const registerBlobTransaction = await walrusClient.registerBlobTransaction({
      blobId: encoded.blobId,
      rootHash: encoded.rootHash,
      size: file.length,
      deletable: true,
      epochs: 3,
      owner: currentAccount!.address,
    });
    registerBlobTransaction.setSender(currentAccount!.address);

    const { digest } = await signAndExecuteTransaction({
      transaction: registerBlobTransaction,
    });

    const { objectChanges, effects } = await suiClient.waitForTransaction({
      digest,
      options: { showObjectChanges: true, showEffects: true },
    });

    if (effects?.status.status !== "success") {
      setError("Failed to register blob");
      console.log(effects);
      return;
    }

    const blobType = await walrusClient.getBlobType();

    const blobObject = objectChanges?.find(
      (change) => change.type === "created" && change.objectType === blobType,
    );

    if (!blobObject || blobObject.type !== "created") {
      setError("Blob object not found");
      console.log(objectChanges);
      return;
    }

    setStatus("Writing blob to nodes...");
    const confirmations = await walrusClient.writeEncodedBlobToNodes({
      blobId: encoded.blobId,
      metadata: encoded.metadata,
      sliversByNode: encoded.sliversByNode,
      deletable: true,
      objectId: blobObject.objectId,
    });

    setStatus("Certifying blob...");

    const certifyBlobTransaction = await walrusClient.certifyBlobTransaction({
      blobId: encoded.blobId,
      blobObjectId: blobObject.objectId,
      confirmations,
      deletable: true,
    });
    certifyBlobTransaction.setSender(currentAccount!.address);

    const { digest: certifyDigest } = await signAndExecuteTransaction({
      transaction: certifyBlobTransaction,
    });

    const { effects: certifyEffects } = await suiClient.waitForTransaction({
      digest: certifyDigest,
      options: { showEffects: true },
    });

    if (certifyEffects?.status.status !== "success") {
      setError("Failed to certify blob");
      console.log(certifyEffects);
      return;
    }

    setStatus(`Blob uploaded as ${encoded.blobId}`);

    return encoded.blobId;
  }

  async function getWal() {
    const suiClient = new SuiClient({
      url: getFullnodeUrl("testnet"),
    });

    const balance = await suiClient.getBalance({
      owner: currentAccount?.address!,
    });

    if (BigInt(balance.totalBalance) < MIST_PER_SUI) {
      await requestSuiFromFaucetV2({
        host: getFaucetHost("testnet"),
        recipient: currentAccount?.address!,
      });
    }

    const walBalance = await suiClient.getBalance({
      owner: currentAccount?.address!,
      coinType: `0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL`,
    });
    console.log("wal balance:", walBalance.totalBalance);

    if (Number(walBalance.totalBalance) < Number(MIST_PER_SUI) / 2) {
      const tx = new Transaction();
      tx.setSender(currentAccount?.address!);

      const exchange = await suiClient.getObject({
        id: TESTNET_WALRUS_PACKAGE_CONFIG.exchangeIds[0],
        options: {
          showType: true,
        },
      });

      const exchangePackageId = parseStructTag(exchange.data?.type!).address;

      const wal = tx.moveCall({
        package: exchangePackageId,
        module: "wal_exchange",
        function: "exchange_all_for_wal",
        arguments: [
          tx.object(TESTNET_WALRUS_PACKAGE_CONFIG.exchangeIds[0]),
          coinWithBalance({
            balance: MIST_PER_SUI / 2n,
          }),
        ],
      });

      tx.transferObjects([wal], currentAccount?.address!);

      const { digest } = await signAndExecuteTransaction({
        transaction: tx,
      });

      const { effects } = await suiClient.waitForTransaction({
        digest,
        options: {
          showEffects: true,
        },
      });

      console.log(effects);
    }
  }
}
