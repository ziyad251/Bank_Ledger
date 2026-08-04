const transactionModel = require("../models/transaction.model")
const ledgerModel = require("../models/ledger.model")
const accountModel = require("../models/account.model")
const emailService = require("../services/email.service")
const mongoose = require("mongoose")

async function createTransaction(req, res) {

    /**
     * 1. Validate request
     */
    const { fromAccount, toAccount, amount, idempotencyKey } = req.body

    if (!fromAccount || !toAccount || !amount || !idempotencyKey) {
        return res.status(400).json({
            message: "FromAccount, toAccount, amount and idempotencyKey are required"
        })
    }

    const fromUserAccount = await accountModel.findOne({
        _id: fromAccount
    })

    const toUserAccount = await accountModel.findOne({
        _id: toAccount
    })

    if (!fromUserAccount || !toUserAccount) {
        return res.status(400).json({
            message: "Invalid fromAccount or toAccount"
        })
    }

    /**
     * 2. Validate idempotency key
     */
    const isTransactionAlreadyExists = await transactionModel.findOne({
        idempotencyKey: idempotencyKey
    })

    if (isTransactionAlreadyExists) {

        if (isTransactionAlreadyExists.status === "COMPLETED") {
            return res.status(200).json({
                message: "Transaction already processed",
                transaction: isTransactionAlreadyExists
            })
        }

        if (isTransactionAlreadyExists.status === "PENDING") {
            return res.status(200).json({
                message: "Transaction is still processing"
            })
        }

        if (isTransactionAlreadyExists.status === "FAILED") {
            return res.status(500).json({
                message: "Transaction processing failed, please retry"
            })
        }

        if (isTransactionAlreadyExists.status === "REVERSED") {
            return res.status(500).json({
                message: "Transaction was reversed, please retry"
            })
        }
    }

    /**
     * 3. Check account status
     */
    if (
        fromUserAccount.status !== "ACTIVE" ||
        toUserAccount.status !== "ACTIVE"
    ) {
        return res.status(400).json({
            message: "Both fromAccount and toAccount must be ACTIVE to process transaction"
        })
    }

    /**
     * 4. Derive sender balance
     */
    const balance = await fromUserAccount.getBalance()

    if (balance < amount) {
        return res.status(400).json({
            message: `Insufficient balance. Current balance is ${balance}. Requested amount is ${amount}`
        })
    }

    let transaction

    try {

        const session = await mongoose.startSession()

        session.startTransaction()

        /**
         * 5. Create PENDING transaction
         */
        transaction = (await transactionModel.create([
            {
                fromAccount,
                toAccount,
                amount,
                idempotencyKey,
                status: "PENDING"
            }
        ], { session }))[0]

        /**
         * 6. Create DEBIT ledger entry
         */
        await ledgerModel.create([
            {
                account: fromAccount,
                amount: amount,
                transaction: transaction._id,
                type: "DEBIT"
            }
        ], { session })

        /**
         * 7. Create CREDIT ledger entry
         */
        await ledgerModel.create([
            {
                account: toAccount,
                amount: amount,
                transaction: transaction._id,
                type: "CREDIT"
            }
        ], { session })

        /**
         * 8. Mark transaction COMPLETED
         */
        await transactionModel.findOneAndUpdate(
            { _id: transaction._id },
            { status: "COMPLETED" },
            { session }
        )

        /**
         * 9. Commit MongoDB transaction
         */
        await session.commitTransaction()

        session.endSession()

    } catch (error) {

        return res.status(400).json({
            message: "Transaction is Pending due to some issue, please retry after sometime"
        })
    }

    /**
     * 10. Send email notification
     */
    await emailService.sendTransactionEmail(
        req.user.email,
        req.user.name,
        amount,
        toAccount
    )

    return res.status(201).json({
        message: "Transaction completed successfully",
        transaction: transaction
    })
}

module.exports = {
    createTransaction
}