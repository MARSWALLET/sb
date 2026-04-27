const axios = require('axios');
require('dotenv').config();

const SQUAD_API_URL = process.env.SQUAD_SECRET_KEY?.startsWith('sandbox_') 
    ? 'https://sandbox-api-d.squadco.com/transaction/initiate'
    : 'https://api-d.squadco.com/transaction/initiate';

/**
 * Initialize a dynamic Squad Payment
 * @param {Object} params 
 * @param {string} params.email - User's email
 * @param {number} params.amount - Amount in Kobo (e.g. 250000 for NGN 2500)
 * @param {string} params.telegramId - User's telegram ID
 * @param {string} params.type - 'points' or 'pro'
 * @param {number} params.points - Number of points if type='points'
 * @returns {Promise<string>} checkoutUrl
 */
async function initiateSquadPayment({ email, amount, telegramId, type, points = 0 }) {
    if (!process.env.SQUAD_SECRET_KEY) {
        throw new Error('SQUAD_SECRET_KEY is missing in environment variables');
    }

    try {
        const response = await axios.post(SQUAD_API_URL, {
            email: email,
            amount: amount,
            initiate_type: 'inline',
            currency: 'NGN',
            callback_url: process.env.MINI_APP_URL || 'https://t.me',
            metadata: {
                telegramId,
                type,
                points
            }
        }, {
            headers: {
                'Authorization': `Bearer ${process.env.SQUAD_SECRET_KEY}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.data && response.data.status === 200 && response.data.data) {
            return response.data.data.checkout_url;
        } else {
            console.error('[Squad API error]', response.data);
            throw new Error('Unsuccessful Squad API response');
        }
    } catch (err) {
        console.error('[Squad Initiation Error]', err.response?.data || err.message);
        throw err;
    }
}

module.exports = {
    initiateSquadPayment
};
